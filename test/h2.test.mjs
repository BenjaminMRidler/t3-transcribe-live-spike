import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkCadence, durationWithinTolerance, bestOffset, segmentGapsMs, modeVerdict } from '../lib/h2.mjs';

test('chunkCadence passes regular chunks and fails a single blob at stop', () => {
  const regular = chunkCadence([1000, 2010, 2990, 4005, 5000], 1000, 5000);
  assert.equal(regular.pass, true);
  assert.equal(regular.medianIntervalMs, 995); // lower median of 980, 995, 1010, 1015
  const oneBlob = chunkCadence([30000], 1000, 30000);
  assert.equal(oneBlob.pass, false);
  const slow = chunkCadence([3000, 6000, 9000], 1000, 9000);
  assert.equal(slow.pass, false);
  assert.throws(() => chunkCadence([1], 0, 10), RangeError);
});

test('durationWithinTolerance allows timeslice + 250 ms', () => {
  assert.equal(durationWithinTolerance(10.9, 10, 1000), true);
  assert.equal(durationWithinTolerance(8.7, 10, 1000), false);
  assert.equal(durationWithinTolerance(30, 4, 3000), false);
});

test('bestOffset finds a planted probe and scores it near 1', () => {
  const reference = Int16Array.from({ length: 4000 }, (_, i) => Math.round(1000 * Math.sin(i * 0.37) + 500 * Math.sin(i * 0.051)));
  const probe = reference.slice(1234, 1534);
  const found = bestOffset(reference, probe, 1200, 100);
  assert.equal(found.offset, 1234);
  assert.ok(found.score > 0.999);
  const coarse = bestOffset(reference, probe, 1200, 100, 2);
  assert.ok(Math.abs(coarse.offset - 1234) <= 1);
  assert.throws(() => bestOffset(reference, new Int16Array(0), 0, 1), RangeError);
});

test('segmentGapsMs reports gaps and overlaps between aligned segments', () => {
  const gaps = segmentGapsMs([{ offset: 0, length: 16000 }, { offset: 16320, length: 16000 }, { offset: 32000, length: 100 }], 16000);
  assert.deepEqual(gaps, [20, -20]);
});

test('modeVerdict combines checks per mode', () => {
  assert.deepEqual(modeVerdict({ c0: true, c1: true, c2: true, c4: true, c5MaxGapMs: 10 }),
    { appendWorks: true, fullResendWorks: true, segmentedWorks: true, anyModeWorks: true });
  const noAppend = modeVerdict({ c0: true, c1: true, c2: false, c4: false, c5MaxGapMs: 120 });
  assert.equal(noAppend.appendWorks, false);
  assert.equal(noAppend.anyModeWorks, false);
  assert.equal(modeVerdict({ c0: false, c1: true, c2: true, c4: false, c5MaxGapMs: null }).segmentedWorks, false);
});

test('windowIsTail accepts correct windows despite codec pre-roll and rejects wrong ones', async () => {
  const { windowIsTail } = await import('../lib/h2.mjs');
  assert.equal(windowIsTail({ lengthSec: 3.955, score: 0.966, offsetFromTailMs: 0 }), true);
  assert.equal(windowIsTail({ lengthSec: 30, score: 1, offsetFromTailMs: 0 }), false); // whole file (E1)
  assert.equal(windowIsTail({ lengthSec: 4, score: 0.95, offsetFromTailMs: 40 }), false);
  assert.equal(windowIsTail({ lengthSec: 4, score: 0.6, offsetFromTailMs: 0 }), false);
});

test('prefixDecodes requires exit 0, audio and a plausible length', async () => {
  const { prefixDecodes } = await import('../lib/h2.mjs');
  assert.equal(prefixDecodes({ status: 0, decodedSec: 0.96, expectedSec: 1.018, timesliceMs: 1000 }), true);
  assert.equal(prefixDecodes({ status: 0, decodedSec: 0, expectedSec: 3.08, timesliceMs: 3000 }), false);
  assert.equal(prefixDecodes({ status: 1, decodedSec: 3, expectedSec: 3, timesliceMs: 3000 }), false);
});

test('loudestProbeStart skips a silent lead-in', async () => {
  const { loudestProbeStart } = await import('../lib/h2.mjs');
  const pcm = new Int16Array(16000);
  for (let i = 9000; i < 13000; i++) pcm[i] = (i % 50) * 100;
  const start = loudestProbeStart(pcm, 4000, 0, 16000, 500);
  assert.ok(start >= 8500 && start <= 9500, `start ${start}`);
});
