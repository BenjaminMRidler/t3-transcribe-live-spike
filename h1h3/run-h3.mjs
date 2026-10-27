// H3 runner: 5-minute recordings in one OpenRouter request with Qwen3 ASR 1.7B.
//   node run-h3.mjs main    -> 3 clips x {webm/opus 32k, m4a/aac 64k} x 4 sequential requests
//   node run-h3.mjs probe   -> the 10-minute WebM probe, 3 requests (finds the length/size limit)
// A container the provider rejects is retried once as 16 kHz mono FLAC (transcode time logged),
// as the methodology (section 5) prescribes. Outcomes go to out/h3/<phase>.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { transcribe, keyUsage, requireApiKey } from './openrouter.mjs';
import { OUT_DIR, ffmpeg } from './ffmpeg.mjs';
import { estimateSpendUsd, withinBudget } from '../lib/plan.mjs';

const MODEL = 'qwen/qwen3-asr-1.7b';
const PRICE = 0.0000075;
const HARD_STOP_USD = 4;
const apiKey = requireApiKey();
const manifest = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'corpus', 'built', 'manifest.json'), 'utf8'));
const LOG_DIR = path.join(OUT_DIR, 'h3');
fs.mkdirSync(LOG_DIR, { recursive: true });

const flacCache = new Map();
function flacOf(rel) {
  if (!flacCache.has(rel)) {
    const target = rel.replace(/\.[a-z0-9]+$/, '.flac');
    const started = performance.now();
    ffmpeg(['-y', '-i', rel, '-ar', '16000', '-ac', '1', '-c:a', 'flac', target]);
    flacCache.set(rel, { rel: target, transcodeMs: performance.now() - started });
  }
  return flacCache.get(rel);
}

async function send(logFile, meta, rel, format, seconds) {
  const audio = fs.readFileSync(path.join(OUT_DIR, rel));
  let result = await transcribe({ apiKey, model: MODEL, audio, format, timeoutMs: 180000 });
  const entry = { at: new Date().toISOString(), model: '1.7b', ...meta, file: rel, format, audioSec: seconds, rawBytes: audio.length, ...result };
  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  if (!result.ok && (result.status === 400 || result.status === 415 || result.status === 422)) {
    const flac = flacOf(rel);
    const flacAudio = fs.readFileSync(path.join(OUT_DIR, flac.rel));
    result = await transcribe({ apiKey, model: MODEL, audio: flacAudio, format: 'flac', timeoutMs: 180000 });
    fs.appendFileSync(logFile, JSON.stringify({
      ...entry, at: new Date().toISOString(), fallbackFrom: format, file: flac.rel, format: 'flac',
      rawBytes: flacAudio.length, transcodeMs: flac.transcodeMs, ...result
    }) + '\n');
  }
  console.log(`${meta.clip} ${format} rep ${meta.rep}: ${result.ok ? 'ok' : 'FAIL ' + result.status} ${result.ms.toFixed(0)} ms`);
}

async function gate(label, seconds) {
  const { usage } = await keyUsage(apiKey);
  const estimate = 2 * estimateSpendUsd(seconds, PRICE);
  if (!withinBudget(usage, estimate, HARD_STOP_USD)) throw new Error(`budget guard refused ${label}`);
  console.log(`[budget] ${label}: spent ${usage} USD, estimate ${estimate.toFixed(4)} USD (x2)`);
}

const phase = process.argv[2];
if (phase === 'main') {
  const logFile = path.join(LOG_DIR, 'main.jsonl');
  await gate('h3 main', manifest.h3.flatMap((c) => Array(8).fill(c.seconds)));
  for (let rep = 1; rep <= 4; rep++) {
    for (const clip of manifest.h3) {
      await send(logFile, { clip: clip.name, rep, container: 'webm-opus-32k' }, clip.webm, 'webm', clip.seconds);
      await send(logFile, { clip: clip.name, rep, container: 'm4a-aac-64k' }, clip.m4a, 'm4a', clip.seconds);
    }
  }
} else if (phase === 'probe') {
  const logFile = path.join(LOG_DIR, 'probe.jsonl');
  await gate('h3 probe', Array(3).fill(manifest.probe.seconds));
  for (let rep = 1; rep <= 3; rep++) {
    await send(logFile, { clip: manifest.probe.name, rep, container: 'webm-opus-32k' }, manifest.probe.webm, 'webm', manifest.probe.seconds);
  }
} else {
  console.error('usage: run-h3.mjs main | probe');
  process.exit(2);
}
console.log(`[budget] spent so far ${(await keyUsage(apiKey)).usage} USD`);
