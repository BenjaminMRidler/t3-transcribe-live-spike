import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWav, encodeWav, sliceWav, durationSec } from '../lib/wav.mjs';

const ramp = Int16Array.from({ length: 16000 * 3 }, (_, i) => (i % 2000) - 1000);

test('encodeWav and parseWav round-trip 16-bit mono PCM', () => {
  const wav = encodeWav(ramp, 16000);
  assert.equal(wav.length, 44 + ramp.length * 2);
  const pcm = parseWav(wav);
  assert.equal(pcm.sampleRate, 16000);
  assert.equal(pcm.channels, 1);
  assert.deepEqual(pcm.samples, ramp);
  assert.equal(durationSec(pcm), 3);
});

test('parseWav skips extra chunks such as LIST before data', () => {
  const plain = encodeWav(Int16Array.from([1, 2, 3]), 8000);
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc'), Buffer.from([0])]);
  const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
  assert.deepEqual(parseWav(withList).samples, Int16Array.from([1, 2, 3]));
});

test('parseWav accepts the streaming data size 0xFFFFFFFF', () => {
  const wav = encodeWav(Int16Array.from([5, -5]), 16000);
  wav.writeUInt32LE(0xffffffff, 40);
  assert.deepEqual(parseWav(wav).samples, Int16Array.from([5, -5]));
});

test('parseWav rejects non-WAV and non-16-bit input', () => {
  assert.throws(() => parseWav(Buffer.from('not a wav file')), /RIFF/);
  const wav = encodeWav(Int16Array.from([1]), 16000);
  wav.writeUInt16LE(24, 34);
  assert.throws(() => parseWav(wav), /16-bit/);
});

test('sliceWav cuts exact sample ranges and clamps the end', () => {
  const pcm = parseWav(encodeWav(ramp, 16000));
  const slice = parseWav(sliceWav(pcm, 1, 2));
  assert.equal(slice.samples.length, 16000);
  assert.equal(slice.samples[0], ramp[16000]);
  const tail = parseWav(sliceWav(pcm, 2.5, 10));
  assert.equal(tail.samples.length, 8000);
  assert.throws(() => sliceWav(pcm, 5, 6), RangeError);
  assert.throws(() => sliceWav(pcm, 2, 1), RangeError);
});
