import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_P95_SAMPLES,
  tiledWindows,
  liveWindows,
  estimateSpendUsd,
  withinBudget,
  h1Verdict,
  h3Verdict
} from '../lib/plan.mjs';
import { percentile } from '../lib/metrics.mjs';

test('tiledWindows covers the clip without overlap and shortens the last window', () => {
  assert.deepEqual(tiledWindows(10, 4), [
    { start: 0, end: 4 },
    { start: 4, end: 8 },
    { start: 8, end: 10 }
  ]);
  assert.equal(tiledWindows(12, 3).length, 4);
});

test('liveWindows emits a trailing window every cadence, clamped at zero', () => {
  assert.deepEqual(liveWindows(10, 4, 3), [
    { start: 0, end: 3 },
    { start: 2, end: 6 },
    { start: 5, end: 9 }
  ]);
});

test('window planners reject non-positive inputs', () => {
  assert.throws(() => tiledWindows(0, 4), RangeError);
  assert.throws(() => liveWindows(10, 4, 0), RangeError);
  assert.throws(() => liveWindows(10, Number.NaN, 3), RangeError);
});

test('estimateSpendUsd applies a per-request billing minimum', () => {
  assert.equal(estimateSpendUsd([3, 4, 5], 0.001), 0.012);
  assert.equal(estimateSpendUsd([3, 4, 5], 0.001, 10), 0.03);
  assert.throws(() => estimateSpendUsd([1], -1), RangeError);
});

test('planned spike spend stays far below the 5 USD cap at catalogue prices', () => {
  // Catalogue prices read 2026-10-26 from OpenRouter (USD per audio second, DeepInfra).
  const price06 = 0.00000333;
  const price17 = 0.0000075;
  const corpusSec = 900; // 15 minutes of speech
  const h1PerModel = [3, 4, 5].flatMap((w) => tiledWindows(corpusSec, w).map((x) => x.end - x.start));
  const h1Reps = 3;
  const h1 = h1Reps * (estimateSpendUsd(h1PerModel, price06) + estimateSpendUsd(h1PerModel, price17));
  // Full-clip baseline: 12 clips totalling 900 s, each in one request, per model per repeat.
  const baseline = h1Reps * (estimateSpendUsd([900], price06) + estimateSpendUsd([900], price17));
  const h3 = estimateSpendUsd(Array(30).fill(300).concat(Array(3).fill(600)), price17);
  // Even with a pessimistic 15 s minimum billed per request the total stays under 4 USD.
  // Baseline and H3 requests are all longer than 15 s, so the minimum does not change them.
  const pessimistic =
    h1Reps * (estimateSpendUsd(h1PerModel, price06, 15) + estimateSpendUsd(h1PerModel, price17, 15)) +
    baseline + h3;
  assert.ok(h1 + baseline + h3 < 0.5, `estimate ${h1 + baseline + h3}`);
  assert.ok(Math.abs(pessimistic - 0.454) < 0.001, `pessimistic ${pessimistic}`);
  assert.ok(pessimistic < 4, `pessimistic ${pessimistic}`);
});

test('withinBudget refuses a batch that would cross the hard stop', () => {
  assert.equal(withinBudget(3.5, 0.4, 4), true);
  assert.equal(withinBudget(3.5, 0.6, 4), false);
});

test('h1Verdict passes only when ratio and latency both hold', () => {
  const base = { wer06: 0.12, wer17: 0.1, p95Ms06: 1200, samples06: MIN_P95_SAMPLES };
  assert.equal(h1Verdict(base).verdict, 'pass');
  assert.equal(h1Verdict({ ...base, wer06: 0.15 }).verdict, 'pass'); // exactly 1.5x
  assert.equal(h1Verdict({ ...base, wer06: 0.16 }).verdict, 'fail');
  assert.equal(h1Verdict({ ...base, p95Ms06: 1500 }).verdict, 'fail');
});

test('h1Verdict is indeterminate without enough samples or with a zero baseline', () => {
  const base = { wer06: 0.12, wer17: 0.1, p95Ms06: 1200, samples06: MIN_P95_SAMPLES };
  assert.equal(h1Verdict({ ...base, samples06: 50 }).verdict, 'indeterminate');
  assert.equal(h1Verdict({ ...base, wer17: 0 }).verdict, 'indeterminate');
});

test('h3Verdict requires 10 runs, no failures and p90 under 15 s', () => {
  const fast = Array(10).fill(8000);
  assert.equal(h3Verdict({ latenciesMs: fast, failures: 0 }, percentile).verdict, 'pass');
  assert.equal(h3Verdict({ latenciesMs: fast, failures: 1 }, percentile).verdict, 'fail');
  const slow = Array(8).fill(8000).concat([16000, 16000]);
  assert.equal(h3Verdict({ latenciesMs: slow, failures: 0 }, percentile).verdict, 'fail');
  // p90 reading: exactly 1 slow run in 10 still passes (declared interpretation).
  const oneSlow = Array(9).fill(8000).concat([16000]);
  assert.equal(h3Verdict({ latenciesMs: oneSlow, failures: 0 }, percentile).verdict, 'pass');
  assert.equal(h3Verdict({ latenciesMs: [1000], failures: 0 }, percentile).verdict, 'indeterminate');
});

test('h3Verdict fails when every request is rejected (review R-1)', () => {
  const allRejected = h3Verdict({ latenciesMs: [], failures: 30 }, percentile);
  assert.equal(allRejected.verdict, 'fail');
  assert.match(allRejected.reasons[0], /30 request\(s\) failed or were rejected/);
  assert.equal(h3Verdict({ latenciesMs: Array(5).fill(8000), failures: 25 }, percentile).verdict, 'fail');
});

test('h3Verdict rejects malformed inputs', () => {
  assert.throws(() => h3Verdict({ latenciesMs: null, failures: 0 }, percentile), TypeError);
  assert.throws(() => h3Verdict({ latenciesMs: [], failures: -1 }, percentile), TypeError);
});

test('h1Verdict rejects non-finite or negative inputs (review R-4)', () => {
  const base = { wer06: 0.12, wer17: 0.1, p95Ms06: 1200, samples06: MIN_P95_SAMPLES };
  assert.throws(() => h1Verdict({ ...base, wer06: Number.NaN }), /wer06 must be a finite/);
  assert.throws(() => h1Verdict({ ...base, p95Ms06: Infinity }), RangeError);
  assert.throws(() => h1Verdict({ ...base, wer17: -0.1 }), RangeError);
  assert.throws(() => h1Verdict({ ...base, samples06: undefined }), RangeError);
});
