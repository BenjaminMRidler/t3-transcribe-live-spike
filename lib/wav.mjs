// Scope 1.6 spike: PCM WAV parsing, slicing and encoding (pure, no I/O).
//
// DECISION: slice windows from decoded 16 kHz mono PCM in Node | ALTERNATIVE REJECTED: one
// ffmpeg (Docker) call per window | RATIONALE: thousands of windows; a container start per
// window would dominate run time, and slicing PCM is exact and unit-testable. The ffmpeg
// window-extraction cost is measured separately on real browser containers.

/**
 * Parse a RIFF/WAVE buffer holding 16-bit PCM.
 * @param {Uint8Array} buffer
 * @returns {{sampleRate:number, channels:number, samples:Int16Array}}
 */
export function parseWav(buffer) {
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE buffer');
  }
  let offset = 12;
  let format = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    let size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      format = {
        audioFormat: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        bitsPerSample: bytes.readUInt16LE(start + 14)
      };
    } else if (id === 'data') {
      if (!format) throw new Error('data chunk before fmt chunk');
      if (format.audioFormat !== 1 || format.bitsPerSample !== 16) {
        throw new Error('only 16-bit PCM WAV is supported');
      }
      // ffmpeg writes 0xFFFFFFFF as the data size when streaming to a pipe.
      if (size === 0xffffffff || start + size > bytes.length) size = bytes.length - start;
      const usable = size - (size % 2);
      const samples = new Int16Array(usable / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(start + i * 2);
      return { sampleRate: format.sampleRate, channels: format.channels, samples };
    }
    offset = start + size + (size % 2);
  }
  throw new Error('no data chunk found');
}

/**
 * Encode interleaved 16-bit PCM samples as a canonical 44-byte-header WAV.
 * @param {Int16Array} samples
 * @param {number} sampleRate
 * @param {number} [channels=1]
 * @returns {Buffer}
 */
export function encodeWav(samples, sampleRate, channels = 1) {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2);
  return out;
}

/**
 * Cut [startSec, endSec) from mono PCM and return it as a WAV buffer.
 * @param {{sampleRate:number, channels:number, samples:Int16Array}} pcm
 */
export function sliceWav(pcm, startSec, endSec) {
  if (pcm.channels !== 1) throw new Error('sliceWav expects mono PCM');
  if (!(startSec >= 0 && endSec > startSec)) throw new RangeError('invalid slice bounds');
  const from = Math.round(startSec * pcm.sampleRate);
  const to = Math.min(Math.round(endSec * pcm.sampleRate), pcm.samples.length);
  if (from >= to) throw new RangeError('slice is outside the audio');
  return encodeWav(pcm.samples.subarray(from, to), pcm.sampleRate, 1);
}

/** Duration in seconds of mono or interleaved PCM. */
export function durationSec(pcm) {
  return pcm.samples.length / pcm.channels / pcm.sampleRate;
}
