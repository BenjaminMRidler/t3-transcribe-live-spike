// Builds the H1/H3 corpus from LibriSpeech test-clean (downloaded at run time into
// spikes/1.6/out/corpus, never committed). Output: out/corpus/built/manifest.json plus WAV,
// WebM/Opus and M4A/AAC files.
//   H1: 12 clips of 60-90 s (6 female, 6 male speakers), 16 kHz mono WAV.
//   H3: 3 clips of >= 300 s (other speakers), as WAV, WebM/Opus 32 kbit/s and M4A/AAC 64 kbit/s,
//       plus one >= 600 s probe made of two H3 clips.
//   Silence: 10 windows of 4 s (5 near-silent, 5 room-like noise), deterministic.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ffmpeg, OUT_DIR, FFMPEG_IMAGE } from './ffmpeg.mjs';
import { flacStreamInfo, parseSpeakers, parseTranscript, takeConsecutive, insertGaps, noise, GAP_SEC } from '../lib/corpus.mjs';
import { parseWav, encodeWav } from '../lib/wav.mjs';

const ROOT = path.join(OUT_DIR, 'corpus', 'LibriSpeech');
const SUBSET = 'test-clean';
const BUILT = path.join(OUT_DIR, 'corpus', 'built');
fs.mkdirSync(BUILT, { recursive: true });

const speakers = parseSpeakers(fs.readFileSync(path.join(ROOT, 'SPEAKERS.TXT'), 'utf8'), SUBSET);

function speakerUtterances(speakerId) {
  const dir = path.join(ROOT, SUBSET, speakerId);
  const chapters = fs.readdirSync(dir).sort((a, b) => Number(a) - Number(b));
  return chapters.flatMap((chapter) => {
    const chapterDir = path.join(dir, chapter);
    const trans = parseTranscript(fs.readFileSync(path.join(chapterDir, `${speakerId}-${chapter}.trans.txt`), 'utf8'));
    return trans.map(({ id, text }) => {
      const file = path.join(chapterDir, `${id}.flac`);
      const head = Buffer.alloc(42);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, head, 0, 42, 0);
      fs.closeSync(fd);
      const info = flacStreamInfo(head);
      return { id, text, chapter, file, samples: info.totalSamples, seconds: info.totalSamples / info.sampleRate };
    });
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Concatenate whole utterances with ffmpeg, then insert the 0.3 s gaps in Node. */
function buildClip(name, utterances) {
  const listFile = path.join(BUILT, `${name}.list.txt`);
  const rawRel = `corpus/built/${name}.raw.wav`;
  // The concat demuxer resolves list paths from the list's directory, so use absolute /work paths.
  fs.writeFileSync(listFile, utterances.map((u) => `file '/work/${path.relative(OUT_DIR, u.file).split(path.sep).join('/')}'`).join('\n') + '\n');
  ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', `corpus/built/${name}.list.txt`, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-bitexact', '-map_metadata', '-1', rawRel]);
  const raw = parseWav(fs.readFileSync(path.join(OUT_DIR, rawRel)));
  const lengths = utterances.map((u) => u.samples);
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total !== raw.samples.length) {
    throw new Error(`${name}: decoded ${raw.samples.length} samples, STREAMINFO says ${total}`);
  }
  const withGaps = insertGaps(raw.samples, lengths, Math.round(GAP_SEC * 16000));
  const wavPath = path.join(BUILT, `${name}.wav`);
  fs.writeFileSync(wavPath, encodeWav(withGaps, 16000));
  fs.rmSync(path.join(OUT_DIR, rawRel));
  fs.rmSync(listFile);
  return {
    name,
    speaker: utterances[0].id.split('-')[0],
    utterances: utterances.map((u) => u.id),
    seconds: withGaps.length / 16000,
    reference: utterances.map((u) => u.text).join(' '),
    wav: path.relative(OUT_DIR, wavPath).split(path.sep).join('/'),
    wavSha256: sha256(wavPath)
  };
}

function encodeVariants(clip) {
  const base = clip.wav.replace(/\.wav$/, '');
  ffmpeg(['-y', '-i', clip.wav, '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', `${base}.webm`]);
  ffmpeg(['-y', '-i', clip.wav, '-c:a', 'aac', '-b:a', '64k', '-ac', '1', `${base}.m4a`]);
  return {
    webm: `${base}.webm`, webmBytes: fs.statSync(path.join(OUT_DIR, `${base}.webm`)).size,
    m4a: `${base}.m4a`, m4aBytes: fs.statSync(path.join(OUT_DIR, `${base}.m4a`)).size
  };
}

const female = speakers.filter((s) => s.sex === 'F');
const male = speakers.filter((s) => s.sex === 'M');
const h1Speakers = [...female.slice(0, 6), ...male.slice(0, 6)];
const h3Speakers = [female[6], male[6], female[7]];

const h1 = [];
for (const speaker of h1Speakers) {
  const utterances = speakerUtterances(speaker.id);
  const pick = takeConsecutive(utterances, 60, 90);
  if (!pick) throw new Error(`speaker ${speaker.id}: no 60-90 s run of utterances`);
  h1.push({ ...buildClip(`h1-${speaker.id}`, pick.utterances), sex: speaker.sex });
  console.log(`built h1-${speaker.id}`);
}

const h3 = [];
for (const speaker of h3Speakers) {
  const utterances = speakerUtterances(speaker.id);
  const pick = takeConsecutive(utterances, 300, 330);
  if (!pick) throw new Error(`speaker ${speaker.id}: no 300-330 s run of utterances`);
  const clip = { ...buildClip(`h3-${speaker.id}`, pick.utterances), sex: speaker.sex };
  h3.push({ ...clip, ...encodeVariants(clip) });
  console.log(`built h3-${speaker.id}`);
}

// 10-minute probe: the first two H3 clips back to back, WebM/Opus only.
const probeSamples = h3.slice(0, 2).map((c) => parseWav(fs.readFileSync(path.join(OUT_DIR, c.wav))).samples);
const probeWav = path.join(BUILT, 'h3-probe-10min.wav');
fs.writeFileSync(probeWav, encodeWav(insertGaps(Int16Array.from([...probeSamples[0], ...probeSamples[1]]), probeSamples.map((s) => s.length), Math.round(GAP_SEC * 16000)), 16000));
const probe = {
  name: 'h3-probe-10min',
  seconds: parseWav(fs.readFileSync(probeWav)).samples.length / 16000,
  reference: `${h3[0].reference} ${h3[1].reference}`,
  wav: 'corpus/built/h3-probe-10min.wav'
};
Object.assign(probe, encodeVariants(probe));

const silence = [];
for (let i = 0; i < 10; i++) {
  const peak = i < 5 ? 8 : 180; // about -72 dBFS and -45 dBFS
  const file = path.join(BUILT, `silence-${i}.wav`);
  fs.writeFileSync(file, encodeWav(noise(4, 16000, peak, 1000 + i), 16000));
  silence.push({ name: `silence-${i}`, kind: i < 5 ? 'near-silent' : 'room-noise', wav: `corpus/built/silence-${i}.wav` });
}

const manifest = {
  builtAt: new Date().toISOString(),
  source: 'LibriSpeech test-clean (openslr.org/12, CC BY 4.0)',
  ffmpegImage: FFMPEG_IMAGE,
  gapSec: GAP_SEC,
  h1,
  h3,
  probe,
  silence
};
fs.writeFileSync(path.join(BUILT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`H1 clips ${h1.length}, total ${h1.reduce((s, c) => s + c.seconds, 0).toFixed(1)} s; H3 clips ${h3.map((c) => c.seconds.toFixed(1)).join(', ')} s; probe ${probe.seconds.toFixed(1)} s`);
