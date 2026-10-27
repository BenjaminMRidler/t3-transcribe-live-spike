// Builds the H2 source WAVs from the corpus (run h1h3/build-corpus.mjs first):
//   source-300.wav = H3 clip h3-2094 (307.9 s, reference transcript known, so browser
//                    recordings of it can be re-sent for H3);
//   source-30.wav  = its first 30 s.
// Usage: node prepare-sources.mjs [--out <h2 out dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWav, sliceWav } from '../lib/wav.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUT = path.resolve(outIndex >= 0 ? args[outIndex + 1] : path.join(here, '..', 'out', 'h2'));
const corpusDir = path.join(here, '..', 'out', 'corpus', 'built');
const manifest = JSON.parse(fs.readFileSync(path.join(corpusDir, 'manifest.json'), 'utf8'));
const clip = manifest.h3.find((c) => c.name === 'h3-2094');
const wav = fs.readFileSync(path.join(here, '..', 'out', clip.wav));
fs.mkdirSync(path.join(OUT, 'sources'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'sources', 'source-300.wav'), wav);
fs.writeFileSync(path.join(OUT, 'sources', 'source-30.wav'), sliceWav(parseWav(wav), 0, 30));
fs.writeFileSync(path.join(OUT, 'sources', 'sources.json'), JSON.stringify({ clip: clip.name, seconds: clip.seconds, reference: clip.reference, wavSha256: clip.wavSha256 }, null, 2));
console.log(`sources written to ${path.join(OUT, 'sources')}`);
