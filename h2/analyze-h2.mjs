// Summary of H2/H4 (CI checks + driver logs) and the H3 re-send of real browser recordings.
// Usage: node analyze-h2.mjs <checks.json> <driver-logs dir> > writes out/summary-h2h4.json
import fs from 'node:fs';
import path from 'node:path';
import { OUT_DIR } from '../h1h3/ffmpeg.mjs';
import { percentile, summarizeLatencies, corpusWer, tailCoverage, werAgainstBestPrefix } from '../lib/metrics.mjs';
import { h3Verdict } from '../lib/plan.mjs';

const [checksFile, driversDir] = process.argv.slice(2);
const checks = JSON.parse(fs.readFileSync(checksFile, 'utf8')).runs;
const drivers = fs.readdirSync(driversDir, { recursive: true })
  .filter((f) => /driver-.*\.json$/.test(f))
  .map((f) => JSON.parse(fs.readFileSync(path.join(driversDir, f), 'utf8')));

const browsers = {};
for (const d of drivers) {
  const key = `${d.browser}-${d.label}`;
  const runs = Object.entries(checks).filter(([name]) => name.startsWith(`${d.browser}_${d.label}_`));
  const append = runs.filter(([, r]) => r.mode === 'append');
  const segmented = runs.filter(([, r]) => r.mode === 'segmented');
  const byMime = {};
  for (const [name, r] of append) {
    const mime = (r.recorderMime || 'unknown').replace(/\s+/g, '');
    (byMime[mime] ??= []).push({
      run: name, timesliceMs: r.timesliceMs, seconds: r.seconds, requestedBitrate: r.requestedBitrate || 0, bitrateKbps: r.bitrateKbps,
      c0: r.c0?.pass, c1: r.c1, firstChunkHasAudio: r.c1FirstChunkHasAudio, c2Direct: r.c2Direct, c2Remux: r.c2Remux, c2InitTail: r.c2InitTail,
      c3LoneChunkDecodes: r.c3LoneChunkDecodes, c4ByteIdentical: r.c4ByteIdentical, appendWorks: r.verdict?.appendWorks, error: r.error
    });
  }
  const appendRows = Object.values(byMime).flat();
  browsers[key] = {
    browser: d.capabilities?.browserName, version: d.capabilities?.browserVersion, platform: d.capabilities?.platformName,
    supported: Object.entries(d.support || {}).filter(([, v]) => v).map(([k]) => k),
    driverOutcomes: d.runs.map((r) => `${r.run.replace(`${d.browser}_${d.label}_`, '')}: ${r.outcome}`),
    appendWorksEverywhere: appendRows.length > 0 && appendRows.every((r) => r.appendWorks),
    directSseofWorksFor: [...new Set(appendRows.filter((r) => r.c2Direct).map((r) => r.run.split('_')[3]))],
    byMime,
    segmented: segmented.map(([name, r]) => ({ run: name, allDecode: r.allDecode, gapsMs: r.gapsMs, maxGapMs: r.c5MaxGapMs, minAlignScore: Math.min(...r.segments.map((s) => s.alignScore ?? 0)) }))
  };
}

// H3 with real browser recordings (review R-1): files-browser300 and files-control logs.
const read = (rel) => (fs.existsSync(path.join(OUT_DIR, rel)) ? fs.readFileSync(path.join(OUT_DIR, rel), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sources = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'h2', 'sources', 'sources.json'), 'utf8'));
const lastWords = sources.reference.split(' ').slice(-12).join(' ');
const h3rows = [...read('h3/files-browser300.jsonl'), ...read('h3/files-control.jsonl')];
const groups = {};
for (const r of h3rows) {
  const name = r.file.includes('browser300') ? r.file.split('/').slice(-2, -1)[0] : r.file.split('/').pop();
  (groups[name] ??= []).push(r);
}
const h3 = {};
for (const [name, rows] of Object.entries(groups)) {
  // Final outcome per (label, rep): a FLAC fallback row replaces the rejected original.
  const final = Object.values(Object.fromEntries(rows.map((r) => [`${r.label}|${r.rep}`, r])));
  const ok = final.filter((r) => r.ok);
  const browserFile = name.includes('_');
  h3[name] = {
    requests: final.length, accepted: ok.length, formats: [...new Set(final.map((r) => r.format))], fallbacks: rows.filter((r) => r.fallbackFrom).length,
    rawBytes: final[0].rawBytes, requestBytes: final[0].requestBytes,
    latencyMs: ok.length ? Object.fromEntries(Object.entries(summarizeLatencies(ok.map((r) => r.ms))).map(([k, v]) => [k, Math.round(v)])) : null,
    latenciesMsInOrder: final.map((r) => `${r.at.slice(11, 19)}Z ${Math.round(r.ms)}`),
    verdict: h3Verdict({ latenciesMs: ok.map((r) => r.ms), failures: final.length - ok.length }, percentile),
    // The browser recordings and the H3 clip h3-2094 share one reference (source-300 = h3-2094).
    wer: ok.length ? Number(corpusWer(ok.map((r) => ({ reference: sources.reference, hypothesis: r.text }))).wer.toFixed(4)) : null,
    // Browser recordings stop at 300 s of the 307.9 s source: score against the best reference
    // prefix (up to 60 words dropped) and report how many words were dropped.
    werBestPrefix: browserFile && ok.length ? (() => {
      const scored = ok.map((r) => werAgainstBestPrefix(sources.reference, r.text, 60));
      return { meanWer: Number((scored.reduce((x, y) => x + y.wer, 0) / scored.length).toFixed(4)), trimmedWords: [...new Set(scored.map((x) => x.trimmedWords))] };
    })() : null,
    minTailCoverage: !browserFile && ok.length ? Number(Math.min(...ok.map((r) => tailCoverage(lastWords, r.text))).toFixed(3)) : null,
    costUsd: Number(rows.reduce((s, r) => s + (r.usage?.cost ?? 0), 0).toFixed(6))
  };
}

const summary = { analysedAt: new Date().toISOString(), checksFile: path.basename(checksFile), browsers, h3BrowserRecordings: h3 };
fs.writeFileSync(path.join(OUT_DIR, 'summary-h2h4.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ browsers: Object.fromEntries(Object.entries(browsers).map(([k, b]) => [k, { version: b.version, appendWorksEverywhere: b.appendWorksEverywhere, directSseofWorksFor: b.directSseofWorksFor, segmented: b.segmented.map((s) => s.maxGapMs) }])), h3: Object.fromEntries(Object.entries(h3).map(([k, v]) => [k, { n: v.requests, ok: v.accepted, p50: v.latencyMs?.p50, p90: v.latencyMs?.p90, max: v.latencyMs?.max, verdict: v.verdict.verdict, wer: v.wer, werBestPrefix: v.werBestPrefix, tail: v.minTailCoverage, req: v.requestBytes }])) }, null, 1));
