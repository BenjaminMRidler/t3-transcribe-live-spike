# T3 Transcribe live transcription feasibility spike

Throwaway spike code for testing four hypotheses before building live dictation transcription:

- **H1:** Qwen3 ASR 0.6B against 1.7B on short live windows, comparing accuracy and latency (`h1h3/run-h1.mjs`).
- **H2:** MediaRecorder timeslice chunks, appended in order, decode as one stream in each browser (`h2/`).
- **H3:** a 5-minute recording transcribes in one request (`h1h3/run-h3.mjs`).
- **H4:** real Safari can be driven from CI. `.github/workflows/h2-browsers.yml` runs the H2 harness in Safari on a GitHub macOS runner through `safaridriver`.

Notes:

- The code uses only the Node standard library; there are no npm dependencies.
- ffmpeg runs from a pinned Docker image.
- LibriSpeech test-clean (CC BY 4.0) is downloaded at run time and is never committed.
- No API key is used in CI. The H1/H3 runs need `OPENROUTER_API_KEY` in the local environment.

Run the unit tests with `node --test "test/*.test.mjs"` (Node 22 or later).
