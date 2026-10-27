// Scope 1.6 spike: request planning, spend estimation and hypothesis verdict rules
// (TASK-000010). Pure functions only; the harnesses built at gate 02 call these.

/** Minimum samples per configuration before a p95 is reported as meaningful. */
export const MIN_P95_SAMPLES = 100;

/**
 * Non-overlapping windows that tile a clip ("tiled-window" accuracy runs). The last
 * window is shorter when the clip length is not a multiple of the window.
 * @param {number} durationSec
 * @param {number} windowSec
 * @returns {{start:number, end:number}[]}
 */
export function tiledWindows(durationSec, windowSec) {
  assertPositive(durationSec, 'durationSec');
  assertPositive(windowSec, 'windowSec');
  const windows = [];
  for (let start = 0; start < durationSec - 1e-9; start += windowSec) {
    windows.push({ start: round3(start), end: round3(Math.min(start + windowSec, durationSec)) });
  }
  return windows;
}

/**
 * Trailing windows the live path would send: one every cadence, each ending "now" and
 * reaching back windowSec (clamped at 0 during the first seconds of a recording).
 * @param {number} durationSec
 * @param {number} windowSec
 * @param {number} cadenceSec
 * @returns {{start:number, end:number}[]}
 */
export function liveWindows(durationSec, windowSec, cadenceSec) {
  assertPositive(durationSec, 'durationSec');
  assertPositive(windowSec, 'windowSec');
  assertPositive(cadenceSec, 'cadenceSec');
  const windows = [];
  for (let end = cadenceSec; end <= durationSec + 1e-9; end += cadenceSec) {
    windows.push({ start: round3(Math.max(0, end - windowSec)), end: round3(end) });
  }
  return windows;
}

/**
 * Estimated provider spend for a list of request audio lengths.
 * @param {number[]} requestSeconds audio seconds per request
 * @param {number} pricePerSecondUsd catalogue price per audio second (calibrated at run time)
 * @param {number} [minBilledSeconds=0] provider minimum billed seconds per request, if any
 * @returns {number} USD
 */
export function estimateSpendUsd(requestSeconds, pricePerSecondUsd, minBilledSeconds = 0) {
  if (!(pricePerSecondUsd >= 0) || !(minBilledSeconds >= 0)) {
    throw new RangeError('prices and minimums must be non-negative');
  }
  const billed = requestSeconds.reduce((sum, s) => sum + Math.max(s, minBilledSeconds), 0);
  return billed * pricePerSecondUsd;
}

/**
 * Budget guard run before every batch: refuse a batch that would cross the hard stop.
 * @param {number} spentUsd measured spend so far (OpenRouter key usage delta)
 * @param {number} nextBatchUsd estimated cost of the next batch
 * @param {number} hardStopUsd stop line (4 USD: 1 USD margin under the 5 USD cap)
 * @returns {boolean} true when the batch may run
 */
export function withinBudget(spentUsd, nextBatchUsd, hardStopUsd) {
  return spentUsd + nextBatchUsd <= hardStopUsd;
}

/**
 * H1 verdict: 0.6B WER <= 1.5 x 1.7B WER on the same clips, and 0.6B p95 latency < 1500 ms.
 * @param {{wer06:number, wer17:number, p95Ms06:number, samples06:number}} m
 * @returns {{verdict:'pass'|'fail'|'indeterminate', reasons:string[]}}
 */
export function h1Verdict({ wer06, wer17, p95Ms06, samples06 }) {
  for (const [name, value] of Object.entries({ wer06, wer17, p95Ms06, samples06 })) {
    if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
      throw new RangeError(`h1Verdict: ${name} must be a finite non-negative number (got ${value})`);
    }
  }
  const reasons = [];
  if (samples06 < MIN_P95_SAMPLES) {
    reasons.push(`only ${samples06} latency samples; ${MIN_P95_SAMPLES} required for p95`);
  }
  if (wer17 === 0) {
    reasons.push('1.7B WER is 0, so the 1.5x ratio is undefined; enlarge the corpus');
  }
  if (reasons.length > 0) {
    return { verdict: 'indeterminate', reasons };
  }
  const ratioOk = wer06 <= 1.5 * wer17;
  const latencyOk = p95Ms06 < 1500;
  if (!ratioOk) reasons.push(`WER ratio ${(wer06 / wer17).toFixed(2)} exceeds 1.5`);
  if (!latencyOk) reasons.push(`p95 latency ${p95Ms06} ms is not under 1500 ms`);
  return { verdict: ratioOk && latencyOk ? 'pass' : 'fail', reasons };
}

/**
 * H3 verdict: every 5-minute request succeeds in one call and p90 latency < 15 000 ms.
 * @param {{latenciesMs:number[], failures:number}} m
 * @param {(values:number[], p:number)=>number} percentileFn
 */
export function h3Verdict({ latenciesMs, failures }, percentileFn) {
  // DECISION: failures are decisive before the sample-size check | ALTERNATIVE REJECTED:
  // sample size first | RATIONALE: a provider rejecting the 5-minute request is the main way
  // H3 fails, and it must trigger the vision's fallback (split at silences), not "inconclusive".
  if (!Array.isArray(latenciesMs) || !Number.isInteger(failures) || failures < 0) {
    throw new TypeError('h3Verdict needs a latency array and a non-negative integer failure count');
  }
  if (failures > 0) {
    return { verdict: 'fail', reasons: [`${failures} request(s) failed or were rejected`] };
  }
  if (latenciesMs.length < 10) {
    return { verdict: 'indeterminate', reasons: ['fewer than 10 attempted 5-minute requests'] };
  }
  // INTERPRETATION (declared): the vision's "under 15 s" is read as p90 < 15 000 ms over
  // at least 10 runs, so 1 run in 10 may exceed 15 s; the max is always reported alongside.
  const p90 = percentileFn(latenciesMs, 90);
  if (!(p90 < 15000)) {
    return { verdict: 'fail', reasons: [`p90 latency ${p90} ms is not under 15000 ms`] };
  }
  return { verdict: 'pass', reasons: [] };
}

function assertPositive(value, name) {
  if (!(typeof value === 'number' && value > 0 && Number.isFinite(value))) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
