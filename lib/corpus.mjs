// Scope 1.6 spike: LibriSpeech corpus selection (pure functions, no I/O).
//
// DECISION: clips are consecutive whole utterances of one speaker with 0.3 s gaps
// | ALTERNATIVE REJECTED: cutting a long chapter at fixed times | RATIONALE: whole utterances
// keep the reference transcript exact; the gap restores a natural pause between sentences.

/** Gap inserted between utterances, in seconds. */
export const GAP_SEC = 0.3;

/**
 * Total samples and sample rate from a FLAC file's STREAMINFO block.
 * @param {Uint8Array} head first bytes of the file (at least 42)
 * @returns {{sampleRate:number, channels:number, totalSamples:number}}
 */
export function flacStreamInfo(head) {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (b.length < 42 || b.toString('ascii', 0, 4) !== 'fLaC') throw new Error('not a FLAC file');
  if ((b[4] & 0x7f) !== 0) throw new Error('first metadata block is not STREAMINFO');
  const s = 8; // STREAMINFO body starts after 'fLaC' + 4-byte block header
  const sampleRate = (b[s + 10] << 12) | (b[s + 11] << 4) | (b[s + 12] >> 4);
  const channels = ((b[s + 12] >> 1) & 0x07) + 1;
  const totalSamples = (b[s + 13] & 0x0f) * 2 ** 32 + b.readUInt32BE(s + 14);
  return { sampleRate, channels, totalSamples };
}

/**
 * Parse LibriSpeech SPEAKERS.TXT and keep the rows of one subset.
 * @returns {{id:string, sex:'F'|'M'}[]}
 */
export function parseSpeakers(text, subset) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith(';'))
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter((parts) => parts[2] === subset)
    .map(([id, sex]) => ({ id, sex }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/** Parse a LibriSpeech *.trans.txt file into ordered {id, text}. */
export function parseTranscript(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const space = line.indexOf(' ');
      return { id: line.slice(0, space), text: line.slice(space + 1).trim() };
    });
}

/**
 * Take consecutive utterances until the clip reaches minSec, never passing maxSec unless a
 * single utterance would leave the clip empty. Durations include the inter-utterance gaps.
 * @param {{id:string, text:string, seconds:number}[]} utterances in reading order
 * @returns {{utterances:typeof utterances, seconds:number}|null} null when minSec is unreachable
 */
export function takeConsecutive(utterances, minSec, maxSec, gapSec = GAP_SEC) {
  const chosen = [];
  let seconds = 0;
  for (const utterance of utterances) {
    const added = utterance.seconds + (chosen.length > 0 ? gapSec : 0);
    if (seconds + added > maxSec && chosen.length > 0) break;
    chosen.push(utterance);
    seconds += added;
    if (seconds >= minSec) return { utterances: chosen, seconds };
  }
  return null;
}

/**
 * Insert gapSamples of silence between consecutive segments of concatenated PCM.
 * @param {Int16Array} samples concatenated segments
 * @param {number[]} segmentLengths sample count of each segment, in order
 * @param {number} gapSamples
 * @returns {Int16Array}
 */
export function insertGaps(samples, segmentLengths, gapSamples) {
  const total = segmentLengths.reduce((sum, n) => sum + n, 0);
  if (total !== samples.length) {
    throw new RangeError(`segment lengths sum to ${total}, but there are ${samples.length} samples`);
  }
  const out = new Int16Array(total + gapSamples * Math.max(0, segmentLengths.length - 1));
  let read = 0;
  let write = 0;
  segmentLengths.forEach((length, index) => {
    out.set(samples.subarray(read, read + length), write);
    read += length;
    write += length + (index < segmentLengths.length - 1 ? gapSamples : 0);
  });
  return out;
}

/**
 * Deterministic low-level noise for the silence/hallucination check (seeded LCG).
 * @param {number} seconds
 * @param {number} sampleRate
 * @param {number} peak maximum absolute sample value (e.g. 10 for near-silence, 180 for room noise)
 * @param {number} seed
 * @returns {Int16Array}
 */
export function noise(seconds, sampleRate, peak, seed) {
  let state = seed >>> 0;
  const out = new Int16Array(Math.round(seconds * sampleRate));
  let smooth = 0;
  for (let i = 0; i < out.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const white = (state / 0xffffffff) * 2 - 1;
    smooth = 0.9 * smooth + 0.1 * white; // gentle low-pass: room-like rather than hiss
    out[i] = Math.round(Math.max(-1, Math.min(1, smooth * 3)) * peak);
  }
  return out;
}
