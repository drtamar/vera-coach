/**
 * Anthropic client plumbing.
 *
 * The SDK is imported lazily so the test suite — which injects a fake client —
 * runs without the dependency installed and without an API key. Nothing else in
 * the project imports the SDK.
 */

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_MAX_TOKENS = 16000;
export const DEFAULT_EFFORT = 'high';   // Opus 5.5 defaults to medium; authoring a drill warrants more

let _client = null;

/** Lazily construct the real SDK client. Credentials resolve from the environment. */
export async function createClient() {
  if (_client) return _client;
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    throw new LLMUnavailable(
      'The Anthropic SDK is not installed. Run `npm i @anthropic-ai/sdk` to enable drill generation.'
    );
  }
  _client = new Anthropic();
  return _client;
}

export class LLMUnavailable extends Error {
  constructor(message) { super(message); this.name = 'LLMUnavailable'; }
}
export class LLMRefused extends Error {
  constructor(message, category) { super(message); this.name = 'LLMRefused'; this.category = category; }
}
export class LLMMalformed extends Error {
  constructor(message, raw) { super(message); this.name = 'LLMMalformed'; this.raw = raw; }
}

/**
 * One structured-output request.
 *
 * Forced tool_choice returns a 400 on this model family, so schema-constrained
 * JSON goes through output_config.format — which is the better fit anyway,
 * since a drill is a document, not a function call.
 */
export async function askForJSON({
  client, system, user, schema,
  model = DEFAULT_MODEL,
  maxTokens = DEFAULT_MAX_TOKENS,
  effort = DEFAULT_EFFORT,
}) {
  const c = client || await createClient();

  let response;
  try {
    response = await c.messages.create({
      model,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      output_config: {
        effort,
        format: { type: 'json_schema', schema },
      },
      system,
      messages: [{ role: 'user', content: user }],
    });
  } catch (err) {
    throw classify(err);
  }

  // Always check stop_reason before reading content — a refusal is HTTP 200.
  if (response.stop_reason === 'refusal') {
    throw new LLMRefused(
      response.stop_details?.explanation || 'The model declined this request.',
      response.stop_details?.category ?? null
    );
  }
  if (response.stop_reason === 'max_tokens') {
    throw new LLMMalformed('Response hit the token ceiling and is truncated.', null);
  }

  const text = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  if (!text.trim()) throw new LLMMalformed('Model returned no text content.', response);

  try {
    return { data: JSON.parse(text), usage: response.usage, model: response.model };
  } catch {
    throw new LLMMalformed('Model output was not valid JSON.', text.slice(0, 500));
  }
}

/** Map SDK errors onto our own types, most specific first. */
function classify(err) {
  const status = err?.status;
  if (status === 401 || status === 403) return new LLMUnavailable(`Authentication failed (${status}). Check credentials.`);
  if (status === 404) return new LLMUnavailable(`Model not found (404). Check the model id.`);
  if (status === 429) { const e = new Error('Rate limited.'); e.name = 'LLMRateLimited'; e.retryable = true; return e; }
  if (status >= 500) { const e = new Error(`Upstream error ${status}.`); e.name = 'LLMUpstream'; e.retryable = true; return e; }
  return err;
}

/** Retry only what is safely retryable, with backoff. */
export async function withRetry(fn, { attempts = 3, baseMs = 500, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      if (!err?.retryable || i === attempts - 1) throw err;
      await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
}
