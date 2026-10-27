// Window extraction cost (methodology section 3, item 4): time for ffmpeg to cut the trailing
// 4 s window as 16 kHz mono WAV from WebM/Opus recordings of 30, 120 and 300 s.
//   - "live" files have no cues and no duration, like Chrome's MediaRecorder output;
//   - "cues" is the same 300 s audio muxed normally (cues + duration) for comparison;
//   - "remux" is a stream copy of the 300 s live file (one way a server could add cues).
// Files are copied into a Docker named volume first: a Windows bind mount adds seconds of
// file I/O that a Linux server would not have. Time is ffmpeg's own -benchmark rtime, so
// container start-up is excluded. Output: out/h1/extract.json.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { OUT_DIR, ffmpeg, FFMPEG_IMAGE } from './ffmpeg.mjs';

const VOLUME = 'spike16-extract';
const docker = (args) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr}`);
  return r;
};
const inVolume = (args) => docker(['run', '--rm', '-v', `${VOLUME}:/data`, '-w', '/data', FFMPEG_IMAGE, '-hide_banner', ...args]);
const rtimeMs = (stderr) => Number(/rtime=([\d.]+)s/.exec(stderr)[1]) * 1000;

const manifest = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'corpus', 'built', 'manifest.json'), 'utf8'));
const source = manifest.h3[0];
fs.mkdirSync(path.join(OUT_DIR, 'h1'), { recursive: true });
for (const seconds of [30, 120, 300]) {
  ffmpeg(['-y', '-t', String(seconds), '-i', source.wav, '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-f', 'webm', '-live', '1', `h1/extract-${seconds}s.webm`]);
}
docker(['volume', 'create', VOLUME]);
docker(['create', '--name', 'spike16cp', '-v', `${VOLUME}:/data`, FFMPEG_IMAGE]);
try {
  for (const seconds of [30, 120, 300]) docker(['cp', path.join(OUT_DIR, 'h1', `extract-${seconds}s.webm`), `spike16cp:/data/live-${seconds}s.webm`]);
  docker(['cp', path.join(OUT_DIR, source.webm), 'spike16cp:/data/cues-300s.webm']);
} finally {
  docker(['rm', 'spike16cp']);
}

const results = [];
for (const name of ['live-30s', 'live-120s', 'live-300s', 'cues-300s']) {
  const runs = [];
  for (let i = 0; i < 5; i++) {
    runs.push(rtimeMs(inVolume(['-benchmark', '-y', '-sseof', '-4', '-i', `${name}.webm`, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '/data/win.wav']).stderr));
  }
  const probe = docker(['run', '--rm', '-v', `${VOLUME}:/data`, '--entrypoint', '/ffprobe', FFMPEG_IMAGE, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '/data/win.wav']);
  results.push({ file: name, operation: 'sseof -4 to 16 kHz WAV', rtimeMs: runs, windowDurationSec: Number(probe.stdout.trim()) });
  console.log(`${name}: ${runs.map((t) => t.toFixed(0)).join(', ')} ms; window ${probe.stdout.trim()} s`);
}
const remux = [];
for (let i = 0; i < 3; i++) remux.push(rtimeMs(inVolume(['-benchmark', '-y', '-i', 'live-300s.webm', '-c', 'copy', '/data/remux.webm']).stderr));
results.push({ file: 'live-300s', operation: 'stream-copy remux (adds cues)', rtimeMs: remux });
console.log(`remux live-300s: ${remux.map((t) => t.toFixed(0)).join(', ')} ms`);
const afterRemux = [];
for (let i = 0; i < 5; i++) {
  afterRemux.push(rtimeMs(inVolume(['-benchmark', '-y', '-sseof', '-4', '-i', 'remux.webm', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '/data/win.wav']).stderr));
}
const remuxProbe = docker(['run', '--rm', '-v', `${VOLUME}:/data`, '--entrypoint', '/ffprobe', FFMPEG_IMAGE, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '/data/win.wav']);
results.push({ file: 'remux of live-300s', operation: 'sseof -4 to 16 kHz WAV', rtimeMs: afterRemux, windowDurationSec: Number(remuxProbe.stdout.trim()) });
console.log(`remuxed sseof: ${afterRemux.map((t) => t.toFixed(0)).join(', ')} ms; window ${remuxProbe.stdout.trim()} s`);
docker(['volume', 'rm', VOLUME]);
fs.writeFileSync(path.join(OUT_DIR, 'h1', 'extract.json'), JSON.stringify({ measuredAt: new Date().toISOString(), image: FFMPEG_IMAGE, note: 'measured while the H1 network run was in progress on the same machine (8 CPUs)', results }, null, 2));
