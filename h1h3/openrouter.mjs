// Scope 1.6 spike: minimal OpenRouter client (I/O adapter). Mirrors the request shape of
// the product adapter (JSON {model, input_audio:{data, format}} to /audio/transcriptions)
// without importing src/. The API key is read from the environment by the caller and is
// never logged, written or returned.

const BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * One transcription request. Never throws for HTTP errors: the outcome is returned so the
 * harness can log failures instead of dropping them.
 * @returns {Promise<{ok:boolean, status:number, ms:number, text:string|null, error:string|null,
 *   requestBytes:number, provider:string|null, usage:object|null, generationId:string|null}>}
 */
export async function transcribe({ apiKey, model, audio, format, timeoutMs = 120000 }) {
  const body = JSON.stringify({
    model,
    input_audio: { data: Buffer.from(audio).toString('base64'), format }
  });
  const started = performance.now();
  let status = 0;
  let raw = '';
  let provider = null;
  let generationId = null;
  try {
    const response = await fetch(`${BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    status = response.status;
    provider = response.headers.get('x-openrouter-provider') ?? null;
    generationId = response.headers.get('x-generation-id') ?? null;
    raw = await response.text();
  } catch (error) {
    return {
      ok: false, status, ms: performance.now() - started, text: null,
      error: `${error.name}: ${error.message}`.slice(0, 300), requestBytes: body.length,
      provider, usage: null, generationId
    };
  }
  const ms = performance.now() - started;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // fall through: unreadable body is a failure below
  }
  const text = typeof parsed?.text === 'string'
    ? parsed.text
    : typeof parsed?.choices?.[0]?.message?.content === 'string'
      ? parsed.choices[0].message.content
      : null;
  const ok = status >= 200 && status < 300 && text !== null;
  return {
    ok, status, ms, text,
    error: ok ? null : raw.slice(0, 300),
    requestBytes: body.length,
    provider: provider ?? parsed?.provider ?? null,
    usage: parsed?.usage ?? null,
    generationId: generationId ?? parsed?.id ?? null
  };
}

/** Key usage and limit in USD (GET /key). */
export async function keyUsage(apiKey) {
  const response = await fetch(`${BASE_URL}/key`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    throw new Error(`key usage request failed with status ${response.status}`);
  }
  const { data } = await response.json();
  return { usage: data.usage, limit: data.limit, limitRemaining: data.limit_remaining ?? null };
}

/** Baseline round trip: a small authenticated-free GET to the endpoints listing. */
export async function baselineRoundTripMs(model) {
  const started = performance.now();
  const response = await fetch(`${BASE_URL}/models/${model}/endpoints`, {
    signal: AbortSignal.timeout(30000)
  });
  await response.text();
  return performance.now() - started;
}

/** Read the key from the process environment; refuse to run without it. */
export function requireApiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error('OPENROUTER_API_KEY is not set in this process environment');
  }
  return key;
}
