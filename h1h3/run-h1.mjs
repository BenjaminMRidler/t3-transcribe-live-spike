// H1 runner: Qwen3 ASR 0.6B vs 1.7B on tiled windows, the full-clip baseline and the
// silence check. Usage (through with-key.ps1 so the key stays in the process environment):
//   node run-h1.mjs calibrate
//   node run-h1.mjs tiled <rep 1..3>
//   node run-h1.mjs baseline <rep 1..3>
//   node run-h1.mjs silence
// Each request is appended to out/h1/<phase>[-rep<N>].jsonl (resumable; failures are logged,
// never dropped). Two model streams run side by side, each with one request in flight and a
// new request started at most every CADENCE_SEC (declared deviation: 2 concurrent sessions).
import fs from 'node:fs';
import path from 'node:path';
import { transcribe, keyUsage, requireApiKey, baselineRoundTripMs, PROVENANCE } from './openrouter.mjs';
import { OUT_DIR } from './ffmpeg.mjs';
import { parseWav, sliceWav } from '../lib/wav.mjs';
import { tiledWindows, estimateSpendUsd, withinBudget } from '../lib/plan.mjs';

export const MODELS = { '0.6b': 'qwen/qwen3-asr-0.6b', '1.7b': 'qwen/qwen3-asr-1.7b' };
const CATALOGUE_PRICE = { '0.6b': 0.00000333, '1.7b': 0.0000075 };
const CADENCE_SEC = 3;
const WINDOWS = [3, 4, 5];
const HARD_STOP_USD = 4;
const PRICE_SAFETY = 2; // estimates are doubled before the budget check

const apiKey = requireApiKey();
const manifest = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'corpus', 'built', 'manifest.json'), 'utf8'));
const LOG_DIR = path.join(OUT_DIR, 'h1');
fs.mkdirSync(LOG_DIR, { recursive: true });
const pcmCache = new Map();
const pcm = (rel) => {
  if (!pcmCache.has(rel)) pcmCache.set(rel, parseWav(fs.readFileSync(path.join(OUT_DIR, rel))));
  return pcmCache.get(rel);
};

function seededShuffle(items, seed) {
  const out = [...items];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function readDone(logFile) {
  if (!fs.existsSync(logFile)) return new Set();
  return new Set(fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).key));
}

async function budgetGate(label, jobs) {
  const { usage } = await keyUsage(apiKey);
  const estimate = PRICE_SAFETY * Object.keys(MODELS).reduce(
    (sum, m) => sum + estimateSpendUsd(jobs.map((j) => j.end - j.start), CATALOGUE_PRICE[m]), 0);
  if (!withinBudget(usage, estimate, HARD_STOP_USD)) {
    throw new Error(`budget guard: spent ${usage} USD + estimate ${estimate.toFixed(4)} USD would pass ${HARD_STOP_USD} USD (${label})`);
  }
  console.log(`[budget] ${label}: spent ${usage} USD, batch estimate ${estimate.toFixed(4)} USD (x${PRICE_SAFETY})`);
  return usage;
}

/** Run jobs for both models as two paced streams; append every outcome to logFile. */
async function runPaced(jobs, logFile, { paced = true } = {}) {
  const done = readDone(logFile);
  const stream = async (modelKey) => {
    let nextStart = performance.now();
    for (const job of jobs) {
      const key = `${modelKey}|${job.key}`;
      if (done.has(key)) continue;
      const wait = nextStart - performance.now();
      if (paced && wait > 0) await new Promise((r) => setTimeout(r, wait));
      nextStart = performance.now() + CADENCE_SEC * 1000;
      const audio = job.audio();
      const result = await transcribe({ apiKey, model: MODELS[modelKey], audio, format: job.format });
      fs.appendFileSync(logFile, JSON.stringify({
        key, at: new Date().toISOString(), ...PROVENANCE, model: modelKey, ...job.meta,
        start: job.start, end: job.end, audioSec: job.end - job.start, ...result
      }) + '\n');
      if (!result.ok) console.log(`[fail] ${key}: ${result.status} ${result.error}`);
    }
  };
  await Promise.all(Object.keys(MODELS).map(stream));
}

function tiledJobs(windowSec) {
  return manifest.h1.flatMap((clip) => tiledWindows(clip.seconds, windowSec).map((w, index) => ({
    key: `${clip.name}|w${windowSec}|${index}`,
    meta: { clip: clip.name, windowSec, index },
    start: w.start, end: w.end, format: 'wav',
    audio: () => sliceWav(pcm(clip.wav), w.start, w.end)
  })));
}

const [phase, repArg] = process.argv.slice(2);
const rep = Number(repArg ?? 1);
const rtt = [];
for (let i = 0; i < 20; i++) rtt.push(await baselineRoundTripMs(MODELS['0.6b']));
rtt.sort((a, b) => a - b);
console.log(`[rtt] median baseline round trip ${rtt[10].toFixed(0)} ms`);
fs.appendFileSync(path.join(LOG_DIR, 'rtt.jsonl'), JSON.stringify({ at: new Date().toISOString(), phase, rep, medianMs: rtt[10], samplesMs: rtt }) + '\n');

if (phase === 'calibrate') {
  // 10 requests of 4 s per model, sequential per model, with key usage read around each model.
  const jobs = tiledJobs(4).slice(0, 10);
  const before = await budgetGate('calibrate', jobs);
  const out = { before };
  for (const modelKey of Object.keys(MODELS)) {
    const start = (await keyUsage(apiKey)).usage;
    const logFile = path.join(LOG_DIR, `calibrate-${modelKey}.jsonl`);
    const done = readDone(logFile);
    for (const job of jobs) {
      if (done.has(`${modelKey}|${job.key}`)) continue;
      const result = await transcribe({ apiKey, model: MODELS[modelKey], audio: job.audio(), format: 'wav' });
      fs.appendFileSync(logFile, JSON.stringify({ key: `${modelKey}|${job.key}`, model: modelKey, ...job.meta, audioSec: job.end - job.start, ...result }) + '\n');
    }
    await new Promise((r) => setTimeout(r, 20000)); // usage accounting can lag
    const end = (await keyUsage(apiKey)).usage;
    out[modelKey] = { usdDelta: end - start, audioSec: jobs.reduce((s, j) => s + j.end - j.start, 0), requests: jobs.length };
  }
  fs.writeFileSync(path.join(LOG_DIR, 'calibration.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
} else if (phase === 'tiled') {
  for (const windowSec of seededShuffle(WINDOWS, rep)) {
    const jobs = seededShuffle(tiledJobs(windowSec), rep * 100 + windowSec);
    await budgetGate(`tiled rep ${rep} w${windowSec}`, jobs);
    await runPaced(jobs, path.join(LOG_DIR, `tiled-rep${rep}.jsonl`));
    console.log(`[done] tiled rep ${rep} w${windowSec}`);
  }
} else if (phase === 'baseline') {
  const jobs = manifest.h1.map((clip) => ({
    key: `${clip.name}|full`, meta: { clip: clip.name }, start: 0, end: clip.seconds, format: 'wav',
    audio: () => fs.readFileSync(path.join(OUT_DIR, clip.wav))
  }));
  await budgetGate(`baseline rep ${rep}`, jobs);
  await runPaced(jobs, path.join(LOG_DIR, `baseline-rep${rep}.jsonl`));
} else if (phase === 'silence') {
  const jobs = manifest.silence.map((s) => ({
    key: `${s.name}`, meta: { clip: s.name, kind: s.kind }, start: 0, end: 4, format: 'wav',
    audio: () => fs.readFileSync(path.join(OUT_DIR, s.wav))
  }));
  await budgetGate('silence', jobs);
  await runPaced(jobs, path.join(LOG_DIR, 'silence.jsonl'));
} else if (phase === 'concurrency') {
  // Load probe (reported, not used for the verdict): 5 parallel 0.6B sessions, 4 s windows,
  // each stream paced at the cadence, 40 requests per stream.
  const all = tiledJobs(4);
  const streams = Array.from({ length: 5 }, (_, s) => all.filter((_, i) => i % 5 === s).slice(0, 40));
  await budgetGate('concurrency', streams.flat());
  const logFile = path.join(LOG_DIR, 'concurrency.jsonl');
  await Promise.all(streams.map(async (jobs, s) => {
    let nextStart = performance.now();
    for (const job of jobs) {
      const wait = nextStart - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      nextStart = performance.now() + CADENCE_SEC * 1000;
      const result = await transcribe({ apiKey, model: MODELS['0.6b'], audio: job.audio(), format: 'wav' });
      fs.appendFileSync(logFile, JSON.stringify({ key: `0.6b|s${s}|${job.key}`, at: new Date().toISOString(), ...PROVENANCE, model: '0.6b', stream: s, ...job.meta, audioSec: job.end - job.start, ...result }) + '\n');
    }
  }));
} else {
  console.error('usage: run-h1.mjs calibrate | tiled <rep> | baseline <rep> | silence | concurrency');
  process.exit(2);
}
const { usage } = await keyUsage(apiKey);
console.log(`[budget] spent so far ${usage} USD`);
