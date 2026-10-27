// Scope 1.6 spike: executable definitions of the benchmark metrics (TASK-000010).
// Pure functions only: no I/O, no network, no dependencies beyond the language.
//
// DECISION: corpus-level (micro-averaged) WER | ALTERNATIVE REJECTED: mean of per-clip WER
// | RATIONALE: per-clip averaging over-weights short clips and is undefined for empty
// references; summing edit counts over all reference words is the standard ASR convention.
//
// DECISION: nearest-rank percentile | ALTERNATIVE REJECTED: linear interpolation
// | RATIONALE: nearest-rank always returns an observed latency, so "p95 < 1.5 s" can be
// traced to a real request in the raw log; with n >= 100 the methods differ negligibly.

/**
 * Normalize a transcript into comparable word tokens. The same normalization is applied
 * to reference and hypothesis, so formatting choices (case, punctuation) are not errors.
 * Digits are kept as written: a "4" vs "four" mismatch counts against both models alike,
 * which keeps the 0.6B/1.7B ratio fair (declared compromise; see methodology section 3).
 * @param {string} text
 * @returns {string[]}
 */
export function normalizeTranscript(text) {
  if (typeof text !== 'string') {
    throw new TypeError('normalizeTranscript expects a string');
  }
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[-‐-―/]/g, ' ')
    // Keep letters, digits and apostrophes inside words; everything else separates words.
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter((word) => word.length > 0);
}

/**
 * Minimum word edit counts turning the reference into the hypothesis (Levenshtein).
 * Ties prefer substitution, then deletion, then insertion, so counts are deterministic.
 * @param {string[]} ref
 * @param {string[]} hyp
 * @returns {{substitutions:number, deletions:number, insertions:number, refWords:number, errors:number}}
 */
export function wordEditCounts(ref, hyp) {
  if (!Array.isArray(ref) || !Array.isArray(hyp)) {
    throw new TypeError('wordEditCounts expects two word arrays');
  }
  const cols = hyp.length + 1;
  // Each cell holds [cost, substitutions, deletions, insertions].
  let prev = Array.from({ length: cols }, (_, j) => [j, 0, 0, j]);
  for (let i = 1; i <= ref.length; i++) {
    const row = [[i, 0, i, 0]];
    for (let j = 1; j <= hyp.length; j++) {
      const same = ref[i - 1] === hyp[j - 1];
      const diag = prev[j - 1];
      const up = prev[j];
      const left = row[j - 1];
      const subCost = diag[0] + (same ? 0 : 1);
      const delCost = up[0] + 1;
      const insCost = left[0] + 1;
      if (subCost <= delCost && subCost <= insCost) {
        row.push([subCost, diag[1] + (same ? 0 : 1), diag[2], diag[3]]);
      } else if (delCost <= insCost) {
        row.push([delCost, up[1], up[2] + 1, up[3]]);
      } else {
        row.push([insCost, left[1], left[2], left[3] + 1]);
      }
    }
    prev = row;
  }
  const [errors, substitutions, deletions, insertions] = prev[hyp.length];
  return { substitutions, deletions, insertions, refWords: ref.length, errors };
}

/**
 * Corpus WER over (reference, hypothesis) text pairs: total edits / total reference words.
 * @param {{reference:string, hypothesis:string}[]} pairs
 * @returns {{wer:number, substitutions:number, deletions:number, insertions:number, refWords:number, errors:number}}
 * @throws {RangeError} when the pairs hold no reference words (WER is undefined).
 */
export function corpusWer(pairs) {
  const total = { substitutions: 0, deletions: 0, insertions: 0, refWords: 0, errors: 0 };
  for (const { reference, hypothesis } of pairs) {
    const counts = wordEditCounts(normalizeTranscript(reference), normalizeTranscript(hypothesis));
    for (const key of Object.keys(total)) {
      total[key] += counts[key];
    }
  }
  if (total.refWords === 0) {
    throw new RangeError('WER is undefined without reference words');
  }
  return { wer: total.errors / total.refWords, ...total };
}

/**
 * Nearest-rank percentile: the smallest observed value with at least p% of values <= it.
 * @param {number[]} values
 * @param {number} p in (0, 100]
 * @returns {number}
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError('percentile needs at least one value');
  }
  if (!(p > 0 && p <= 100)) {
    throw new RangeError('percentile p must be in (0, 100]');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1];
}

/**
 * Completeness check for long requests (H3): share of the final reference utterance's words
 * matched in the tail of the hypothesis (tail length = utterance length + 5 words).
 * A truncated transcript scores near 0; a complete one near 1 - (local error rate).
 * @param {string} lastUtterance
 * @param {string} hypothesis
 * @returns {number} in [0, 1]
 */
export function tailCoverage(lastUtterance, hypothesis) {
  const ref = normalizeTranscript(lastUtterance);
  if (ref.length === 0) throw new RangeError('tailCoverage needs a non-empty utterance');
  const hyp = normalizeTranscript(hypothesis);
  const tail = hyp.slice(Math.max(0, hyp.length - (ref.length + 5)));
  const { substitutions, deletions } = wordEditCounts(ref, tail);
  return Math.max(0, 1 - (substitutions + deletions) / ref.length);
}

/**
 * Latency summary reported for every configuration.
 * @param {number[]} latenciesMs
 */
export function summarizeLatencies(latenciesMs) {
  const n = latenciesMs.length;
  const mean = latenciesMs.reduce((sum, v) => sum + v, 0) / (n || 1);
  return {
    n,
    p50: percentile(latenciesMs, 50),
    p90: percentile(latenciesMs, 90),
    p95: percentile(latenciesMs, 95),
    max: Math.max(...latenciesMs),
    mean
  };
}
