// Scope 1.6 spike, H2: pure analysis functions for MediaRecorder chunk checks (no I/O).

/**
 * C0: observed chunk cadence against the requested timeslice.
 * @param {number[]} arrivalMs client time of each dataavailable event, ms since recorder start
 * @param {number} timesliceMs
 * @param {number} recordedMs total recording time before stop()
 */
export function chunkCadence(arrivalMs, timesliceMs, recordedMs) {
  if (!(timesliceMs > 0) || !(recordedMs > 0)) throw new RangeError('timeslice and recorded time must be positive');
  const intervals = arrivalMs.slice(1).map((t, i) => t - arrivalMs[i]);
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const expectedChunks = Math.floor(recordedMs / timesliceMs);
  // Pass: chunks keep arriving during recording (at least 80% of the expected count before
  // the final flush) and the median interval is within 25% of the timeslice.
  const pass = arrivalMs.length >= Math.max(2, Math.floor(0.8 * expectedChunks)) &&
    median !== null && Math.abs(median - timesliceMs) <= 0.25 * timesliceMs;
  return { chunks: arrivalMs.length, expectedChunks, medianIntervalMs: median, pass };
}

/**
 * C1 tolerance: a decoded prefix must be within (timeslice + 250 ms) of the recorded time.
 * @param {number} decodedSec
 * @param {number} expectedSec
 * @param {number} timesliceMs
 */
export function durationWithinTolerance(decodedSec, expectedSec, timesliceMs) {
  return Math.abs(decodedSec - expectedSec) <= (timesliceMs + 250) / 1000;
}

/**
 * Normalized cross-correlation of probe against reference at reference offsets
 * [centre - radius, centre + radius]; returns the best offset and its score in [-1, 1].
 * @param {Int16Array|Float32Array} reference
 * @param {Int16Array|Float32Array} probe
 * @param {number} centre expected offset in samples
 * @param {number} radius search radius in samples
 * @param {number} [step=1] offset step in samples (coarse search)
 */
export function bestOffset(reference, probe, centre, radius, step = 1) {
  if (probe.length === 0) throw new RangeError('probe is empty');
  let probeEnergy = 0;
  for (let i = 0; i < probe.length; i++) probeEnergy += probe[i] * probe[i];
  let best = { offset: null, score: -Infinity };
  const from = Math.max(0, Math.round(centre - radius));
  const to = Math.min(reference.length - probe.length, Math.round(centre + radius));
  for (let offset = from; offset <= to; offset += step) {
    let dot = 0;
    let refEnergy = 0;
    for (let i = 0; i < probe.length; i++) {
      const r = reference[offset + i];
      dot += r * probe[i];
      refEnergy += r * r;
    }
    const denominator = Math.sqrt(refEnergy * probeEnergy);
    const score = denominator > 0 ? dot / denominator : 0;
    if (score > best.score) best = { offset, score };
  }
  return best;
}

/**
 * C5: audio lost between consecutive segments, from each segment's aligned start offset in
 * the source and its decoded length (both in samples).
 * @param {{offset:number, length:number}[]} segments in recording order
 * @param {number} sampleRate
 * @returns {number[]} gap in ms between segment i and i+1 (negative = overlap)
 */
export function segmentGapsMs(segments, sampleRate) {
  return segments.slice(1).map((segment, i) => {
    const previous = segments[i];
    return ((segment.offset - (previous.offset + previous.length)) / sampleRate) * 1000;
  });
}

/**
 * Per-cell verdict (methodology section 4).
 * @param {{c0:boolean, c1:boolean, c2:boolean, c4:boolean, c5MaxGapMs:number|null}} r
 */
export function modeVerdict({ c0, c1, c2, c4, c5MaxGapMs }) {
  const append = Boolean(c0 && c1 && c2);
  const fullResend = Boolean(c4);
  const segmented = c5MaxGapMs !== null && c5MaxGapMs !== undefined && c5MaxGapMs <= 50;
  return { appendWorks: append, fullResendWorks: fullResend, segmentedWorks: segmented, anyModeWorks: append || fullResend || segmented };
}
