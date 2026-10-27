// Scope 1.6 H2 harness (browser side). URL parameters:
//   run       run identifier (folder name on the server)
//   mode      'append' (timeslice chunks) or 'segmented' (stop/restart every segmentMs)
//   mime      requested MIME type ('' = browser default)
//   timeslice timeslice in ms (append mode)
//   segment   segment length in ms (segmented mode)
//   source    'source-30' or 'source-300' (served WAV)
//   seconds   recording length in seconds
// window.__h2 exposes progress for the WebDriver driver: { state, error, info }.
(function () {
  'use strict';
  var CANDIDATES = [
    'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg',
    'audio/mp4;codecs=mp4a.40.2', 'audio/mp4;codecs=opus', 'audio/mp4', 'audio/aac'
  ];
  var params = new URLSearchParams(location.search);
  var run = params.get('run') || 'manual-' + Date.now();
  var mode = params.get('mode') || 'append';
  var mime = params.get('mime') || '';
  var timeslice = Number(params.get('timeslice') || 1000);
  var segmentMs = Number(params.get('segment') || 3000);
  var source = params.get('source') || 'source-30';
  var seconds = Number(params.get('seconds') || 30);
  var statusEl = document.getElementById('status');
  var h2 = window.__h2 = { state: 'idle', error: null, info: null, uploads: 0 };
  var pending = [];

  function log(text) { statusEl.textContent = text; }
  function fail(error) {
    h2.state = 'error';
    h2.error = String(error && (error.stack || error.message) || error);
    log('error: ' + h2.error);
    post('/done?run=' + encodeURIComponent(run), JSON.stringify({ error: h2.error, userAgent: navigator.userAgent }), 'application/json');
  }
  function post(path, body, type) {
    var p = fetch(path, { method: 'POST', body: body, headers: { 'Content-Type': type || 'application/octet-stream' } })
      .then(function (r) { if (!r.ok) throw new Error('upload ' + path + ' failed ' + r.status); h2.uploads++; });
    pending.push(p);
    return p;
  }
  function supportInfo() {
    var support = {};
    CANDIDATES.forEach(function (c) { support[c] = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c); });
    return support;
  }
  function makeRecorder(stream) {
    var options = mime ? { mimeType: mime } : {};
    return new MediaRecorder(stream, options);
  }

  async function start() {
    h2.state = 'starting';
    var t0 = performance.now();
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
    var response = await fetch('/' + source + '.wav');
    if (!response.ok) throw new Error('source fetch failed ' + response.status);
    var buffer = await ctx.decodeAudioData(await response.arrayBuffer());
    var dest = ctx.createMediaStreamDestination();
    var node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(dest);
    var info = {
      run: run, mode: mode, requestedMime: mime, timesliceMs: timeslice, segmentMs: segmentMs, source: source,
      seconds: seconds, userAgent: navigator.userAgent, support: supportInfo(), contextSampleRate: ctx.sampleRate,
      chunks: [], segments: []
    };
    h2.info = info;

    if (mode === 'append') {
      var chunks = [];
      var recorder = makeRecorder(dest.stream);
      info.recorderMime = recorder.mimeType;
      var stopped = new Promise(function (resolve) { recorder.onstop = resolve; });
      var recStart;
      recorder.ondataavailable = function (event) {
        var at = performance.now() - recStart;
        var seq = chunks.length;
        chunks.push(event.data);
        info.chunks.push({ seq: seq, atMs: Math.round(at), bytes: event.data.size, type: event.data.type });
        post('/chunk?run=' + encodeURIComponent(run) + '&seq=' + seq, event.data);
      };
      recorder.onerror = function (e) { fail(e.error || e); };
      node.start();
      recorder.start(timeslice);
      recStart = performance.now();
      info.recorderStartedMs = Math.round(recStart - t0);
      h2.state = 'recording';
      log('recording ' + seconds + ' s as ' + recorder.mimeType);
      await new Promise(function (r) { setTimeout(r, seconds * 1000); });
      info.recordedMs = Math.round(performance.now() - recStart);
      recorder.stop();
      await stopped;
      // C4: the client-built full-resend body (MTG-1-0011 fallback).
      post('/fullresend?run=' + encodeURIComponent(run), new Blob(chunks, { type: recorder.mimeType }));
    } else {
      // Segmented recording with a hand-over: the next recorder starts before the previous
      // one stops, so segments should overlap slightly instead of losing audio.
      var segStart = performance.now();
      info.recorderStartedMs = Math.round(segStart - t0);
      var finished = [];
      function startSegment(seq) {
        var rec = makeRecorder(dest.stream);
        info.recorderMime = rec.mimeType;
        var parts = [];
        var entry = { seq: seq, startMs: Math.round(performance.now() - segStart) };
        rec.ondataavailable = function (event) { parts.push(event.data); };
        var done = new Promise(function (resolve) {
          rec.onstop = function () {
            var blob = new Blob(parts, { type: rec.mimeType });
            entry.bytes = blob.size;
            info.segments.push(entry);
            post('/segment?run=' + encodeURIComponent(run) + '&seq=' + seq, blob).then(resolve, resolve);
          };
        });
        rec.start();
        return { rec: rec, entry: entry, done: done };
      }
      node.start();
      h2.state = 'recording';
      var seqN = 0;
      var current = startSegment(seqN++);
      while (performance.now() - segStart < seconds * 1000) {
        await new Promise(function (r) { setTimeout(r, segmentMs); });
        var next = performance.now() - segStart < seconds * 1000 ? startSegment(seqN++) : null;
        current.entry.stopMs = Math.round(performance.now() - segStart);
        current.rec.stop();
        finished.push(current.done);
        if (!next) break;
        current = next;
      }
      await Promise.all(finished);
      info.segments.sort(function (a, b) { return a.seq - b.seq; });
      info.recordedMs = Math.round(performance.now() - segStart);
    }
    node.stop();
    await ctx.close();
    await Promise.all(pending);
    await post('/done?run=' + encodeURIComponent(run), JSON.stringify(info), 'application/json');
    h2.state = 'done';
    log('done: ' + (info.chunks.length || info.segments.length) + ' parts');
  }

  document.getElementById('start').addEventListener('click', function () {
    if (h2.state !== 'idle') return;
    start().catch(fail);
  });
  // Report support without recording, for the matrix planner.
  window.__h2support = supportInfo();
})();
