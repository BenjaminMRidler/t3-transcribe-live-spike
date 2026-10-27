// Scope 1.6 H2/H4: drives the harness page in a real browser through the W3C WebDriver
// protocol, using fetch only (no npm dependency). The browser drivers are the ones already
// installed on GitHub runner images (chromedriver, msedgedriver, geckodriver, safaridriver).
//
// DECISION: raw W3C WebDriver over fetch | ALTERNATIVES REJECTED: Playwright (cannot drive
// real Safari; npm dependency), Selenium (npm dependency for the same protocol) | RATIONALE:
// one ~150-line client drives all four browsers, real Safari included (methodology section 4).
//
// Usage: node drive.mjs --browser chrome|edge|firefox|safari [--plan full|quick] [--port 8616]
//        [--out <dir>] [--label <os>]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const browser = option('browser');
const plan = option('plan', 'full');
const pagePort = Number(option('port', 8616));
const label = option('label', process.platform);
const OUT = path.resolve(option('out', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'h2')));
const exe = process.platform === 'win32' ? '.exe' : '';
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const AUTOPLAY = ['--autoplay-policy=no-user-gesture-required'];

const DRIVERS = {
  chrome: { bin: () => path.join(process.env.CHROMEWEBDRIVER || '', `chromedriver${exe}`), args: (p) => [`--port=${p}`], port: 9515,
    caps: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--headless=new', ...AUTOPLAY] } } },
  edge: { bin: () => path.join(process.env.EDGEWEBDRIVER || '', `msedgedriver${exe}`), args: (p) => [`--port=${p}`], port: 9516,
    caps: { browserName: 'MicrosoftEdge', 'ms:edgeOptions': { args: ['--headless=new', ...AUTOPLAY] } } },
  firefox: { bin: () => path.join(process.env.GECKOWEBDRIVER || '', `geckodriver${exe}`), args: (p) => ['--port', String(p)], port: 4444,
    caps: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'], prefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 } } } },
  safari: { bin: () => '/usr/bin/safaridriver', args: (p) => ['-p', String(p)], port: 4445, caps: { browserName: 'safari' } }
};
const MIMES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4;codecs=opus'];

const driverDef = DRIVERS[browser];
if (!driverDef) {
  console.error('usage: node drive.mjs --browser chrome|edge|firefox|safari');
  process.exit(2);
}
const base = `http://127.0.0.1:${driverDef.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`WebDriver ${method} ${route} -> ${response.status} ${JSON.stringify(json.value ?? json).slice(0, 400)}`);
  return json.value;
}

const driverBin = process.env.DRIVER_PATH || driverDef.bin();
const driverProcess = spawn(driverBin, driverDef.args(driverDef.port), { stdio: 'inherit' });
let sessionId = null;
const log = { browser, label, plan, driver: driverBin, startedAt: new Date().toISOString(), runs: [] };
const logFile = path.join(OUT, `driver-${browser}-${label}.json`);
fs.mkdirSync(OUT, { recursive: true });
const saveLog = () => fs.writeFileSync(logFile, JSON.stringify(log, null, 2));

try {
  for (let i = 0; ; i++) {
    try {
      const status = await wd('GET', '/status');
      if (status?.ready !== false) break;
    } catch (error) {
      if (i > 60) throw new Error(`driver did not start: ${error.message}`);
    }
    await sleep(500);
  }
  const session = await wd('POST', '/session', { capabilities: { alwaysMatch: driverDef.caps } });
  sessionId = session.sessionId;
  log.capabilities = { browserName: session.capabilities?.browserName, browserVersion: session.capabilities?.browserVersion, platformName: session.capabilities?.platformName };
  console.log(`session ${log.capabilities.browserName} ${log.capabilities.browserVersion} on ${log.capabilities.platformName}`);
  const S = `/session/${sessionId}`;
  await wd('POST', `${S}/timeouts`, { script: 30000, pageLoad: 60000 });

  await wd('POST', `${S}/url`, { url: `http://127.0.0.1:${pagePort}/` });
  log.support = await wd('POST', `${S}/execute/sync`, { script: 'return window.__h2support;', args: [] });
  log.userAgent = await wd('POST', `${S}/execute/sync`, { script: 'return navigator.userAgent;', args: [] });
  saveLog();

  const supported = MIMES.filter((m) => log.support?.[m]);
  const cells = [];
  const slug = (m) => (m || 'default').replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '');
  const id = (parts) => [browser, label, ...parts].join('_');
  for (const mime of supported) {
    for (const timeslice of plan === 'quick' ? [1000] : [1000, 3000]) {
      cells.push({ run: id(['append', slug(mime), `ts${timeslice}`, '30s']), mode: 'append', mime, timeslice, source: 'source-30', seconds: 30 });
    }
  }
  cells.push({ run: id(['append', 'default', 'ts3000', '30s']), mode: 'append', mime: '', timeslice: 3000, source: 'source-30', seconds: 30 });
  // Bitrate control: the defaults are about 128-150 kbit/s, which makes 5 minutes exceed 5 MB.
  cells.push({ run: id(['append', 'default', 'ts3000', 'br32k', '30s']), mode: 'append', mime: '', timeslice: 3000, bitrate: 32000, source: 'source-30', seconds: 30 });
  if (plan === 'full') {
    cells.push({ run: id(['append', 'default', 'ts3000', '300s']), mode: 'append', mime: '', timeslice: 3000, source: 'source-300', seconds: 300 });
    for (const segment of [3000, 10000]) {
      cells.push({ run: id(['segmented', 'default', `seg${segment}`, '30s']), mode: 'segmented', mime: '', segment, source: 'source-30', seconds: 30 });
    }
  }

  for (const cell of cells) {
    const query = new URLSearchParams({ run: cell.run, mode: cell.mode, mime: cell.mime, timeslice: String(cell.timeslice ?? 1000), segment: String(cell.segment ?? 3000), bitrate: String(cell.bitrate ?? 0), source: cell.source, seconds: String(cell.seconds) });
    const entry = { ...cell, startedAt: new Date().toISOString() };
    log.runs.push(entry);
    try {
      await wd('POST', `${S}/url`, { url: `http://127.0.0.1:${pagePort}/?${query}` });
      const element = await wd('POST', `${S}/element`, { using: 'css selector', value: '#start' });
      await wd('POST', `${S}/element/${element[ELEMENT]}/click`, {});
      const deadline = Date.now() + (cell.seconds + 90) * 1000;
      let state = null;
      while (Date.now() < deadline) {
        await sleep(2000);
        state = await wd('POST', `${S}/execute/sync`, { script: 'return window.__h2 ? { state: window.__h2.state, error: window.__h2.error, uploads: window.__h2.uploads } : null;', args: [] });
        if (state && (state.state === 'done' || state.state === 'error')) break;
      }
      entry.result = state;
      entry.outcome = state?.state === 'done' ? 'done' : state?.state === 'error' ? 'error' : 'timeout';
    } catch (error) {
      entry.outcome = 'driver-error';
      entry.error = error.message;
    }
    entry.finishedAt = new Date().toISOString();
    console.log(`${cell.run}: ${entry.outcome}${entry.result?.error ? ' ' + entry.result.error.slice(0, 200) : ''}${entry.error ? ' ' + entry.error : ''}`);
    saveLog();
  }
} finally {
  if (sessionId) await wd('DELETE', `/session/${sessionId}`).catch(() => {});
  driverProcess.kill();
  log.finishedAt = new Date().toISOString();
  saveLog();
}
