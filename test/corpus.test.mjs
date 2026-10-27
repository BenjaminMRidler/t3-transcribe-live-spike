import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flacStreamInfo, parseSpeakers, parseTranscript, takeConsecutive, insertGaps, noise
} from '../lib/corpus.mjs';

function fakeFlacHead({ sampleRate, channels, totalSamples }) {
  const b = Buffer.alloc(42);
  b.write('fLaC', 0, 'ascii');
  b[4] = 0x80; // last-block flag + type 0 (STREAMINFO)
  b.writeUIntBE(34, 5, 3);
  const s = 8;
  b[s + 10] = (sampleRate >> 12) & 0xff;
  b[s + 11] = (sampleRate >> 4) & 0xff;
  b[s + 12] = ((sampleRate & 0x0f) << 4) | ((channels - 1) << 1) | 0; // bps high bit 0
  b[s + 13] = (15 << 4) | Math.floor(totalSamples / 2 ** 32); // bps low bits = 15 (16-bit)
  b.writeUInt32BE(totalSamples % 2 ** 32, s + 14);
  return b;
}

test('flacStreamInfo reads sample rate, channels and total samples', () => {
  assert.deepEqual(flacStreamInfo(fakeFlacHead({ sampleRate: 16000, channels: 1, totalSamples: 123456 })), {
    sampleRate: 16000, channels: 1, totalSamples: 123456
  });
  assert.throws(() => flacStreamInfo(Buffer.alloc(42)), /not a FLAC/);
});

test('parseSpeakers keeps one subset, sorted numerically', () => {
  const text = [
    ';ID |SEX| SUBSET | MINUTES | NAME',
    '121  | F | test-clean | 8.0 | A',
    '19   | F | train-clean-100 | 25 | B',
    '1089 | M | test-clean | 8.1 | C'
  ].join('\n');
  assert.deepEqual(parseSpeakers(text, 'test-clean'), [
    { id: '121', sex: 'F' }, { id: '1089', sex: 'M' }
  ]);
});

test('parseTranscript splits id and text', () => {
  assert.deepEqual(parseTranscript('1089-1-0000 HE HOPED THERE\n1089-1-0001 STUFF IT\n'), [
    { id: '1089-1-0000', text: 'HE HOPED THERE' }, { id: '1089-1-0001', text: 'STUFF IT' }
  ]);
});

test('takeConsecutive stops once the minimum is reached and never passes the maximum', () => {
  const u = (id, seconds) => ({ id, text: id, seconds });
  const result = takeConsecutive([u('a', 30), u('b', 20), u('c', 20), u('d', 5)], 60, 90, 0.5);
  assert.deepEqual(result.utterances.map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(result.seconds, 71);
  assert.equal(takeConsecutive([u('a', 30), u('b', 70)], 60, 90, 0), null);
  assert.equal(takeConsecutive([u('a', 10)], 60, 90), null);
});

test('insertGaps places silence between segments only', () => {
  const out = insertGaps(Int16Array.from([1, 1, 2, 3, 3]), [2, 1, 2], 2);
  assert.deepEqual(Array.from(out), [1, 1, 0, 0, 2, 0, 0, 3, 3]);
  assert.throws(() => insertGaps(Int16Array.from([1]), [2], 1), RangeError);
});

test('noise is deterministic and bounded by the peak', () => {
  const a = noise(0.1, 16000, 100, 7);
  assert.equal(a.length, 1600);
  assert.deepEqual(a, noise(0.1, 16000, 100, 7));
  assert.ok(a.every((v) => Math.abs(v) <= 100));
  assert.ok(a.some((v) => v !== 0));
});
