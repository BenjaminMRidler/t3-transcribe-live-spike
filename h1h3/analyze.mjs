// Analysis of the H1/H3 logs into out/summary-h1h3.json (no network, no key).
import fs from 'node:fs';
import path from 'node:path';
import { OUT_DIR } from './ffmpeg.mjs';
import { corpusWer, summarizeLatencies, percentile, tailCoverage, normalizeTranscript } from '../lib/metrics.mjs';
import { h1Verdict, h3Verdict } from '../lib/plan.mjs';

const read = (rel) => {
  const file = path.join(OUT_DIR, rel);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const manifest = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'corpus', 'built', 'manifest.json'), 'utf8'));
const refOf = Object.fromEntries([...manifest.h1, ...manifest.h3, manifest.probe].map((c) => [c.name, c.reference]));
const models = ['0.6b', '1.7b'];
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round = (x, d = 4) => (x === null || x === undefined ? x : Math.round(x * 10 ** d) / 10 ** d);
const latency = (rows) => {
  const ok = rows.filter((r) => r.ok).map((r) => r.ms);
  if (ok.length === 0) return { n: 0 };
  const s = summarizeLatencies(ok);
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, round(v, 0)]));
};
const cost = (rows) => sum(rows.map((r) => r.usage?.cost ?? 0));

// ---- H1 tiled ----
const tiledByRep = [1, 2, 3].map((rep) => read(`h1/tiled-rep${rep}.jsonl`));
const tiledAll = tiledByRep.flat();
const h1 = { windows: {} };
for (const windowSec of [3, 4, 5]) {
  const entry = {};
  for (const model of models) {
    const pairsAllReps = [];
    const perRep = [];
    tiledByRep.forEach((rows, i) => {
      const mine = rows.filter((r) => r.model === model && r.windowSec === windowSec);
      if (mine.length === 0) return;
      const pairs = manifest.h1.map((clip) => ({
        reference: clip.reference,
        hypothesis: mine.filter((r) => r.clip === clip.name).sort((a, b) => a.index - b.index).map((r) => (r.ok ? r.text : '')).join(' ')
      }));
      pairsAllReps.push(...pairs);
      perRep.push({ rep: i + 1, requests: mine.length, failures: mine.filter((r) => !r.ok).length, wer: round(corpusWer(pairs).wer), p95Ms: latency(mine).p95 });
    });
    const rows = tiledAll.filter((r) => r.model === model && r.windowSec === windowSec);
    if (rows.length === 0) continue;
    const pooled = corpusWer(pairsAllReps);
    entry[model] = {
      wer: round(pooled.wer), substitutions: pooled.substitutions, deletions: pooled.deletions, insertions: pooled.insertions, refWords: pooled.refWords,
      perRep, requests: rows.length, failures: rows.filter((r) => !r.ok).length,
      latencyMs: latency(rows), requestBytes: rows[0].requestBytes, costUsd: round(cost(rows), 6)
    };
  }
  if (entry['0.6b'] && entry['1.7b']) entry.werRatio = round(entry['0.6b'].wer / entry['1.7b'].wer, 3);
  h1.windows[`${windowSec}s`] = entry;
}
const w4 = h1.windows['4s'];
if (w4?.['0.6b'] && w4?.['1.7b']) {
  h1.verdict = h1Verdict({ wer06: w4['0.6b'].wer, wer17: w4['1.7b'].wer, p95Ms06: w4['0.6b'].latencyMs.p95, samples06: w4['0.6b'].latencyMs.n });
  // Fallback alternatives the vision names (reported, not the verdict).
  h1.fallbacks = {
    '1.7b at 4 s': { p95Ms: w4['1.7b'].latencyMs.p95 },
    '0.6b at 5 s': h1.windows['5s']?.['0.6b'] ? { wer: h1.windows['5s']['0.6b'].wer, p95Ms: h1.windows['5s']['0.6b'].latencyMs.p95, ratioVs17At5: h1.windows['5s'].werRatio } : null
  };
}

// ---- H1 full-clip baseline ----
const baseline = [1, 2, 3].flatMap((rep) => read(`h1/baseline-rep${rep}.jsonl`).map((r) => ({ ...r, rep })));
h1.fullClipBaseline = {};
for (const model of models) {
  const rows = baseline.filter((r) => r.model === model);
  if (rows.length === 0) continue;
  const w = corpusWer(rows.map((r) => ({ reference: refOf[r.clip], hypothesis: r.ok ? r.text : '' })));
  h1.fullClipBaseline[model] = { wer: round(w.wer), refWords: w.refWords, requests: rows.length, failures: rows.filter((r) => !r.ok).length, latencyMs: latency(rows), costUsd: round(cost(rows), 6) };
}

// ---- H1 silence ----
const silence = read('h1/silence.jsonl');
h1.silence = {};
for (const model of models) {
  const rows = silence.filter((r) => r.model === model);
  if (rows.length === 0) continue;
  const hallucinated = rows.filter((r) => r.ok && normalizeTranscript(r.text).length > 0);
  h1.silence[model] = { windows: rows.length, failures: rows.filter((r) => !r.ok).length, withWords: hallucinated.length, rate: round(hallucinated.length / rows.length, 3), texts: hallucinated.map((r) => `${r.clip}: ${r.text}`) };
}

// ---- extraction ----
const extractFile = path.join(OUT_DIR, 'h1', 'extract.json');
h1.extraction = fs.existsSync(extractFile) ? JSON.parse(fs.readFileSync(extractFile, 'utf8')).results : null;
h1.rtt = read('h1/rtt.jsonl').map((r) => ({ phase: r.phase, rep: r.rep, medianMs: round(r.medianMs, 0) }));
h1.calibration = fs.existsSync(path.join(OUT_DIR, 'h1', 'calibration.json')) ? JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'h1', 'calibration.json'), 'utf8')) : null;
h1.providers = [...new Set([...tiledAll, ...baseline].map((r) => r.provider ?? 'not reported'))];

// ---- H1 load probe: 5 parallel 0.6B sessions (reported, not used for the verdict) ----
const concurrency = read('h1/concurrency.jsonl');
if (concurrency.length) {
  h1.loadProbe5Sessions = { requests: concurrency.length, failures: concurrency.filter((r) => !r.ok).length, latencyMs: latency(concurrency) };
}
// Single-stream sequential latency (calibration batch, 10 per model): shows whether two concurrent streams matter.
h1.calibrationLatencyMs = Object.fromEntries(models.map((m) => [m, latency(read(`h1/calibrate-${m}.jsonl`))]));

// ---- H3 ----
const h3Rows = read('h3/main.jsonl');
const h3 = { containers: {} };
for (const container of [...new Set(h3Rows.map((r) => r.container))]) {
  // The final outcome per (clip, rep): a FLAC fallback row replaces a rejected original.
  const rows = h3Rows.filter((r) => r.container === container);
  const finalRows = Object.values(Object.fromEntries(rows.map((r) => [`${r.clip}|${r.rep}`, r])));
  const original = rows.filter((r) => !r.fallbackFrom);
  const ok = finalRows.filter((r) => r.ok);
  const lastUtterance = (clip) => {
    const c = manifest.h3.find((x) => x.name === clip);
    return c ? c.reference.split(/(?<=\S) (?=\S)/).slice(-12).join(' ') : '';
  };
  h3.containers[container] = {
    requests: original.length,
    acceptedAsRecorded: original.filter((r) => r.ok).length,
    rejectedAsRecorded: original.filter((r) => !r.ok).map((r) => `${r.status}: ${String(r.error).slice(0, 160)}`),
    usedFlacFallback: rows.filter((r) => r.fallbackFrom).length,
    rawBytes: [...new Set(original.map((r) => r.rawBytes))],
    requestBytes: [...new Set(finalRows.map((r) => r.requestBytes))],
    latencyMs: latency(finalRows),
    verdict: h3Verdict({ latenciesMs: ok.map((r) => r.ms), failures: finalRows.length - ok.length }, percentile),
    verdictOnRecordedContainer: h3Verdict({ latenciesMs: original.filter((r) => r.ok).map((r) => r.ms), failures: original.filter((r) => !r.ok).length }, percentile),
    wer: ok.length ? round(corpusWer(ok.map((r) => ({ reference: refOf[r.clip], hypothesis: r.text }))).wer) : null,
    minTailCoverage: ok.length ? round(Math.min(...ok.map((r) => tailCoverage(lastUtterance(r.clip), r.text))), 3) : null,
    costUsd: round(cost(rows), 6)
  };
}
const probe = read('h3/probe.jsonl');
if (probe.length) {
  const ok = probe.filter((r) => r.ok);
  h3.probe10min = {
    requests: probe.length, ok: ok.length, statuses: probe.map((r) => r.status), rawBytes: probe[0].rawBytes, requestBytes: probe.map((r) => r.requestBytes),
    latencyMs: latency(probe), wer: ok.length ? round(corpusWer(ok.map((r) => ({ reference: refOf[r.clip], hypothesis: r.text }))).wer) : null,
    errors: probe.filter((r) => !r.ok).map((r) => String(r.error).slice(0, 200))
  };
}

const spend = round(cost([...tiledAll, ...baseline, ...silence, ...h3Rows, ...probe, ...concurrency, ...read('h1/calibrate-0.6b.jsonl'), ...read('h1/calibrate-1.7b.jsonl')]), 6);
const summary = { analysedAt: new Date().toISOString(), corpus: { h1Clips: manifest.h1.length, h1Seconds: round(sum(manifest.h1.map((c) => c.seconds)), 1), h3Seconds: manifest.h3.map((c) => round(c.seconds, 1)), probeSeconds: round(manifest.probe.seconds, 1) }, spendFromResponsesUsd: spend, h1, h3 };
fs.writeFileSync(path.join(OUT_DIR, 'summary-h1h3.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, (k, v) => (k === 'texts' || k === 'extraction' ? undefined : v), 2));
