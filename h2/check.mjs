// Scope 1.6 H2: checks C0-C5 on recorded runs (methodology section 4) with the pinned
// ffmpeg image. Reads <out>/h2/runs/*/ (out = spikes/1.6/out) and writes <out>/h2/checks.json.
// Usage: node check.mjs [--only <substring>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ffmpeg, OUT_DIR, FFMPEG_IMAGE } from '../h1h3/ffmpeg.mjs';
import { parseWav } from '../lib/wav.mjs';
import { chunkCadence, durationWithinTolerance, bestOffset, segmentGapsMs, modeVerdict } from '../lib/h2.mjs';

const RATE = 16000;
const H2 = path.join(OUT_DIR, 'h2');
const only = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : null; })();
const rel = (p) => path.relative(OUT_DIR, p).split(path.sep).join('/');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ext = (mime) => (mime?.startsWith('audio/webm') ? 'webm' : mime?.startsWith('audio/ogg') ? 'ogg' : mime?.startsWith('audio/mp4') ? 'mp4' : 'bin');

/** Decode a file to 16 kHz mono PCM. Returns {ok, errors, pcm}. */
function decode(file, extra = []) {
  const wav = `${file}.dec.wav`;
  const r = ffmpeg(['-v', 'error', '-y', ...extra, '-i', rel(file), '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_s16le', rel(wav)], { allowFailure: true });
  const errors = (r.stderr || '').trim();
  let pcm = null;
  if (fs.existsSync(wav)) {
    try { pcm = parseWav(fs.readFileSync(wav)).samples; } catch { pcm = null; }
    fs.rmSync(wav);
  }
  return { ok: r.status === 0 && errors === '' && pcm !== null && pcm.length > 0, status: r.status, errors: errors.slice(0, 300), pcm };
}

/** Is `window` the true last 4 s of `full`? Score by normalized correlation near the tail. */
function windowMatchesTail(full, window) {
  if (!window || window.length < 0.5 * RATE || !full || full.length < window.length) return { match: false, score: null };
  const lengthOk = Math.abs(window.length / RATE - 4) <= 0.1;
  const found = bestOffset(full, window, full.length - window.length, 0.05 * RATE, 1);
  return { match: lengthOk && found.score >= 0.98, lengthSec: window.length / RATE, score: Number(found.score.toFixed(4)), offsetFromTailMs: Math.round(((full.length - window.length) - found.offset) / RATE * 1000) };
}

function checkAppend(dir, info) {
  const e = ext(info.recorderMime);
  const chunkFiles = fs.readdirSync(dir).filter((f) => /^chunk-\d+\.bin$/.test(f)).sort();
  const chunks = chunkFiles.map((f) => fs.readFileSync(path.join(dir, f)));
  const result = { chunks: chunks.length, bytes: chunks.reduce((s, c) => s + c.length, 0) };
  result.bitrateKbps = Math.round((result.bytes * 8) / (info.recordedMs / 1000) / 1000);
  result.c0 = chunkCadence(info.chunks.map((c) => c.atMs), info.timesliceMs, info.recordedMs);
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const prefixFile = (k) => {
    const file = path.join(work, `prefix-${String(k).padStart(4, '0')}.${e}`);
    fs.writeFileSync(file, Buffer.concat(chunks.slice(0, k + 1)));
    return file;
  };
  // C1: every prefix for 30 s runs, every 10th (and the last) for long runs.
  const step = chunks.length > 40 ? 10 : 1;
  const ks = [];
  for (let k = 0; k < chunks.length; k += step) ks.push(k);
  if (ks[ks.length - 1] !== chunks.length - 1) ks.push(chunks.length - 1);
  result.c1Prefixes = [];
  const prefixPcm = new Map();
  for (const k of ks) {
    const file = prefixFile(k);
    const d = decode(file);
    const expectedSec = (k === chunks.length - 1 ? info.recordedMs : info.chunks[k].atMs) / 1000;
    const decodedSec = d.pcm ? d.pcm.length / RATE : 0;
    const pass = d.ok && durationWithinTolerance(decodedSec, expectedSec, info.timesliceMs);
    result.c1Prefixes.push({ k, expectedSec, decodedSec: Number(decodedSec.toFixed(3)), ok: d.ok, pass, errors: d.errors || undefined });
    if (d.pcm) prefixPcm.set(k, d.pcm);
    fs.rmSync(file);
  }
  result.c1 = result.c1Prefixes.every((p) => p.pass);

  // C2: the trailing 4 s window at several points, three extraction strategies.
  const n = Math.ceil(4000 / info.timesliceMs) + 1;
  const c2Ks = ks.filter((k) => info.chunks[k] && info.chunks[k].atMs >= 8000);
  const c2Points = (chunks.length > 40 ? c2Ks.filter((_, i) => i % 6 === 0) : c2Ks.filter((_, i) => i % Math.max(1, Math.floor(c2Ks.length / 3)) === 0)).slice(0, 5);
  if (!c2Points.includes(chunks.length - 1)) c2Points.push(chunks.length - 1);
  result.c2Points = [];
  for (const k of c2Points) {
    const full = prefixPcm.get(k) || decode(prefixFile(k)).pcm;
    const file = prefixFile(k);
    const direct = decode(file, ['-sseof', '-4']);
    const remuxFile = path.join(work, `remux-${k}.${e}`);
    const remux = ffmpeg(['-v', 'error', '-y', '-i', rel(file), '-c', 'copy', rel(remuxFile)], { allowFailure: true });
    const remuxWin = remux.status === 0 ? decode(remuxFile, ['-sseof', '-4']) : { ok: false, pcm: null, errors: remux.stderr.slice(0, 200) };
    const initTailFile = path.join(work, `inittail-${k}.${e}`);
    fs.writeFileSync(initTailFile, Buffer.concat([chunks[0], ...chunks.slice(Math.max(1, k - n + 1), k + 1)]));
    const initTail = decode(initTailFile);
    const initTailWin = initTail.pcm ? initTail.pcm.subarray(Math.max(0, initTail.pcm.length - 4 * RATE)) : null;
    result.c2Points.push({
      k, prefixSec: full ? Number((full.length / RATE).toFixed(3)) : null,
      direct: { decodeOk: direct.ok, ...windowMatchesTail(full, direct.pcm) },
      remux: { decodeOk: remuxWin.ok, ...windowMatchesTail(full, remuxWin.pcm) },
      initTail: { decodeOk: initTail.ok, errors: initTail.errors || undefined, ...windowMatchesTail(full, initTailWin) }
    });
    for (const f of [file, remuxFile, initTailFile]) if (fs.existsSync(f)) fs.rmSync(f);
  }
  const all = (key) => result.c2Points.every((p) => p[key].match);
  result.c2Direct = all('direct');
  result.c2Remux = all('remux');
  result.c2InitTail = all('initTail');
  result.c2 = result.c2Direct || result.c2Remux || result.c2InitTail;

  // C3: a lone later chunk.
  if (chunks.length > 2) {
    const lone = path.join(work, `lone-2.${e}`);
    fs.writeFileSync(lone, chunks[2]);
    const d = decode(lone);
    result.c3LoneChunkDecodes = d.ok;
    result.c3Errors = d.errors || undefined;
    fs.rmSync(lone);
  }
  // C4: client full-resend bytes against the appended chunks.
  const fullResendPath = path.join(dir, 'fullresend.bin');
  if (fs.existsSync(fullResendPath)) {
    const fr = fs.readFileSync(fullResendPath);
    result.c4ByteIdentical = sha(fr) === sha(Buffer.concat(chunks));
    result.c4 = result.c4ByteIdentical ? result.c1 && result.c2 : null;
  }
  fs.rmSync(work, { recursive: true, force: true });
  return result;
}

function checkSegmented(dir, info, sourcePcm) {
  const files = fs.readdirSync(dir).filter((f) => /^segment-\d+\.bin$/.test(f)).sort();
  const e = ext(info.recorderMime);
  const segments = [];
  for (const [i, f] of files.entries()) {
    const file = path.join(dir, `seg-${i}.${e}`);
    fs.copyFileSync(path.join(dir, f), file);
    const d = decode(file);
    fs.rmSync(file);
    const meta = info.segments.find((s) => s.seq === i) || {};
    let offset = null;
    let score = null;
    if (d.pcm && d.pcm.length > RATE) {
      const probe = d.pcm.subarray(4000, 12000); // skip the first 0.25 s (encoder start-up)
      const found = bestOffset(sourcePcm, probe, (meta.startMs ?? 0) / 1000 * RATE + 4000, RATE, 1);
      offset = found.offset - 4000;
      score = Number(found.score.toFixed(4));
    }
    segments.push({ seq: i, decodeOk: d.ok, errors: d.errors || undefined, seconds: d.pcm ? Number((d.pcm.length / RATE).toFixed(3)) : 0, offset, length: d.pcm ? d.pcm.length : 0, alignScore: score, startMs: meta.startMs, stopMs: meta.stopMs });
  }
  const aligned = segments.filter((s) => s.offset !== null && s.alignScore >= 0.8);
  const gaps = aligned.length === segments.length ? segmentGapsMs(aligned, RATE).map((g) => Math.round(g)) : null;
  return {
    segments,
    allDecode: segments.every((s) => s.decodeOk),
    gapsMs: gaps,
    c5MaxGapMs: gaps && segments.every((s) => s.decodeOk) ? Math.max(0, ...gaps) : null
  };
}

const sourcePcm = parseWav(fs.readFileSync(path.join(H2, 'sources', 'source-30.wav'))).samples;
const runsDir = path.join(H2, 'runs');
const out = { checkedAt: new Date().toISOString(), image: FFMPEG_IMAGE, runs: {} };
for (const run of fs.readdirSync(runsDir).sort()) {
  if (only && !run.includes(only)) continue;
  const dir = path.join(runsDir, run);
  const infoFile = path.join(dir, 'info.json');
  if (!fs.existsSync(infoFile)) { out.runs[run] = { error: 'no info.json' }; continue; }
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  if (info.error) { out.runs[run] = { error: info.error, userAgent: info.userAgent }; continue; }
  const started = Date.now();
  try {
    const base = { mode: info.mode, recorderMime: info.recorderMime, requestedMime: info.requestedMime, timesliceMs: info.timesliceMs, seconds: info.seconds, recordedMs: info.recordedMs, userAgent: info.userAgent };
    out.runs[run] = info.mode === 'segmented' ? { ...base, ...checkSegmented(dir, info, sourcePcm) } : { ...base, ...checkAppend(dir, info) };
    if (info.mode === 'append') {
      const r = out.runs[run];
      r.verdict = modeVerdict({ c0: r.c0.pass, c1: r.c1, c2: r.c2, c4: r.c4, c5MaxGapMs: null });
    }
  } catch (error) {
    out.runs[run] = { error: `check failed: ${error.message}` };
  }
  console.log(`${run}: ${JSON.stringify(out.runs[run].verdict ?? { c5MaxGapMs: out.runs[run].c5MaxGapMs, error: out.runs[run].error })} (${Math.round((Date.now() - started) / 1000)} s)`);
  fs.writeFileSync(path.join(H2, 'checks.json'), JSON.stringify(out, null, 2));
}
fs.writeFileSync(path.join(H2, 'checks.json'), JSON.stringify(out, null, 2));
