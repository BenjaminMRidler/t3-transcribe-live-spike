// Scope 1.6 spike: ffmpeg through a pinned Docker image (PO decision R3: nothing installed
// system-wide). spikes/1.6/out is mounted at /work; pass paths relative to it.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const FFMPEG_IMAGE =
  'mwader/static-ffmpeg:7.1@sha256:a8090df5f5608daef387e1b2e93b98aaacb4d92153ad904e7d715c725724fca4';
export const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');

/** Run a tool of the image ('ffmpeg' or 'ffprobe') with /work mounted. Throws on non-zero exit. */
export function runTool(tool, args, { allowFailure = false } = {}) {
  const result = spawnSync(
    'docker',
    [
      'run', '--rm', '-v', `${OUT_DIR}:/work`, '-w', '/work',
      // On Linux, write files as the calling user so Node can overwrite or delete them.
      ...(typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : []),
      '--entrypoint', `/${tool}`, FFMPEG_IMAGE, ...args
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${tool} failed (${result.status}): ${(result.stderr || '').slice(-800)}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export const ffmpeg = (args, options) => runTool('ffmpeg', ['-hide_banner', '-nostdin', ...args], options);
