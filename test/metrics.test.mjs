import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTranscript,
  wordEditCounts,
  corpusWer,
  percentile,
  summarizeLatencies,
  tailCoverage,
  werAgainstBestPrefix
} from '../lib/metrics.mjs';

test('normalizeTranscript ignores case, punctuation and curly apostrophes', () => {
  assert.deepEqual(normalizeTranscript('Hello, World! It’s  well-known.'), [
    'hello', 'world', "it's", 'well', 'known'
  ]);
  assert.deepEqual(normalizeTranscript('  \n '), []);
  assert.deepEqual(normalizeTranscript("'quoted' words"), ['quoted', 'words']);
});

test('normalizeTranscript keeps digits as written', () => {
  assert.deepEqual(normalizeTranscript('Room 4B at 10:30'), ['room', '4b', 'at', '10', '30']);
});

test('normalizeTranscript rejects non-strings', () => {
  assert.throws(() => normalizeTranscript(null), TypeError);
});

test('wordEditCounts identical sequences have no errors', () => {
  const words = ['a', 'b', 'c'];
  assert.deepEqual(wordEditCounts(words, words), {
    substitutions: 0, deletions: 0, insertions: 0, refWords: 3, errors: 0
  });
});

test('wordEditCounts counts substitution, deletion and insertion separately', () => {
  assert.equal(wordEditCounts(['a', 'b', 'c'], ['a', 'x', 'c']).substitutions, 1);
  const del = wordEditCounts(['a', 'b', 'c'], ['a', 'c']);
  assert.equal(del.deletions, 1);
  assert.equal(del.errors, 1);
  const ins = wordEditCounts(['a', 'c'], ['a', 'b', 'c']);
  assert.equal(ins.insertions, 1);
  assert.equal(ins.errors, 1);
});

test('wordEditCounts handles empty hypothesis and empty reference', () => {
  assert.deepEqual(wordEditCounts(['a', 'b'], []), {
    substitutions: 0, deletions: 2, insertions: 0, refWords: 2, errors: 2
  });
  assert.deepEqual(wordEditCounts([], ['a']), {
    substitutions: 0, deletions: 0, insertions: 1, refWords: 0, errors: 1
  });
});

test('corpusWer micro-averages over all reference words', () => {
  const result = corpusWer([
    { reference: 'one two three four', hypothesis: 'one two three four' },
    { reference: 'five six', hypothesis: 'five' }
  ]);
  assert.equal(result.refWords, 6);
  assert.equal(result.errors, 1);
  assert.equal(result.wer, 1 / 6);
});

test('corpusWer sums substitutions, deletions and insertions across pairs (review R-5a)', () => {
  const result = corpusWer([
    { reference: 'a b c', hypothesis: 'a x c' }, // 1 substitution
    { reference: 'd e f', hypothesis: 'd f' }, // 1 deletion
    { reference: 'g h', hypothesis: 'g h i j' } // 2 insertions
  ]);
  assert.deepEqual(
    { s: result.substitutions, d: result.deletions, i: result.insertions, n: result.refWords, e: result.errors },
    { s: 1, d: 1, i: 2, n: 8, e: 4 }
  );
});

test('corpusWer can exceed 1 when insertions dominate', () => {
  assert.equal(corpusWer([{ reference: 'a', hypothesis: 'x y z' }]).wer, 3);
});

test('corpusWer refuses a corpus without reference words', () => {
  assert.throws(() => corpusWer([{ reference: '...', hypothesis: 'a' }]), RangeError);
});

test('percentile uses nearest rank', () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(percentile(values, 95), 95);
  assert.equal(percentile(values, 50), 50);
  assert.equal(percentile(values, 100), 100);
  assert.equal(percentile([7, 1, 3], 95), 7);
  assert.equal(percentile([5], 1), 5);
});

test('percentile rejects empty input and out-of-range p', () => {
  assert.throws(() => percentile([], 95), RangeError);
  assert.throws(() => percentile([1], 0), RangeError);
  assert.throws(() => percentile([1], 101), RangeError);
});

test('tailCoverage is 1 for a complete transcript and low for a truncated one', () => {
  const last = 'and so the story ends here tonight';
  assert.equal(tailCoverage(last, `many words before. ${last}.`), 1);
  assert.ok(tailCoverage(last, 'many words before but the request was cut off early') < 0.3);
  assert.ok(tailCoverage(last, 'words before and so the story end here tonight') >= 0.85);
  assert.throws(() => tailCoverage('...', 'a'), RangeError);
});

test('tailCoverage counts deletions when the transcript stops early (review R-5b)', () => {
  // The hypothesis ends 4 words before the reference: only deletions, no substitutions.
  const last = 'one two three four five six seven eight';
  assert.equal(tailCoverage(last, 'one two three four'), 0.5);
});

test('summarizeLatencies reports n, percentiles, max and mean', () => {
  const summary = summarizeLatencies([100, 200, 300, 400]);
  assert.deepEqual(summary, { n: 4, p50: 200, p90: 400, p95: 400, max: 400, mean: 250 });
});

test('werAgainstBestPrefix ignores reference words after the recording stopped', () => {
  const result = werAgainstBestPrefix('one two three four five six', 'one two three four', 5);
  assert.deepEqual(result, { wer: 0, trimmedWords: 2, refWords: 4, errors: 0 });
  const capped = werAgainstBestPrefix('one two three four five six', 'one two', 1);
  assert.equal(capped.trimmedWords, 1);
  assert.equal(capped.errors, 3);
});
