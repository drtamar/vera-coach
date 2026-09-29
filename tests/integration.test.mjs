/**
 * Integration against the real SDK — no credentials required.
 *
 * Every other suite injects a fake client, which means they validate this
 * project's assumptions against its own assumptions. This one puts the actual
 * SDK in the path and inspects what reaches the wire, which is where a version
 * skew or a silently-dropped parameter shows up.
 *
 * It caught exactly that: an `^0.70.0` pin resolved to 0.70.1, because caret on
 * a 0.x version only allows patch bumps. That SDK predates `output_config`,
 * `effort` and `claude-opus-5-5` entirely.
 *
 * Skips cleanly when the optional SDK is not installed.
 */
import http from 'node:http';

const pass = [], fail = [];
const t = (n, c, extra='') => (c ? pass : fail).push(n + (c ? '' : `  ${extra}`));

let Anthropic;
try { ({ default: Anthropic } = await import('@anthropic-ai/sdk')); }
catch {
  console.log('  SKIP  @anthropic-ai/sdk not installed (npm i)');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

const { version } = await import('@anthropic-ai/sdk/version.mjs').catch(() => ({ version: null }));

/* ---------- the SDK is new enough for the API we target ---------- */
{
  const c = new Anthropic({ apiKey: 'sk-probe' });
  t('sdk: exposes messages.create', typeof c.messages?.create === 'function');
  t('sdk: exposes messages.parse — absent before ~0.100, a version-skew canary',
    typeof c.messages?.parse === 'function',
    `this SDK is too old for the targeted API${version ? ` (${version})` : ''}`);
}

/* ---------- what actually reaches the wire ---------- */
{
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      received = JSON.parse(body || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_x', type: 'message', role: 'assistant', model: 'probe',
        content: [{ type: 'text', text: '{"ok":true}' }],
        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const client = new Anthropic({ apiKey: 'sk-probe', baseURL: `http://127.0.0.1:${server.address().port}` });

  await client.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 64,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } },
    system: 'probe',
    messages: [{ role: 'user', content: 'probe' }],
  });
  server.close();

  t('wire: model id is sent verbatim', received.model === 'claude-opus-5-5', JSON.stringify(received.model));
  t('wire: adaptive thinking survives', received.thinking?.type === 'adaptive', JSON.stringify(received.thinking));
  t('wire: output_config survives', received.output_config !== undefined, 'DROPPED BY SDK');
  t('wire: effort survives', received.output_config?.effort === 'high', JSON.stringify(received.output_config));
  t('wire: json_schema format survives',
    received.output_config?.format?.type === 'json_schema', JSON.stringify(received.output_config?.format));
  t('wire: no forced tool_choice is sent (400s on this model family)', received.tool_choice === undefined);
}

/* ---------- a real transport error classifies correctly ---------- */
{
  const { askForJSON, LLMUnavailable } = await import('../server/llm.mjs');
  // 127.0.0.1:1 refuses immediately — a real connection error, not a fake
  const client = new Anthropic({ apiKey: 'sk-probe', baseURL: 'http://127.0.0.1:1', maxRetries: 0 });
  let err = null;
  try { await askForJSON({ client, system: 's', user: 'u', schema: { type: 'object' } }); }
  catch (e) { err = e; }
  t('transport: a real connection failure propagates rather than hanging', err !== null, String(err));
  t('transport: it is not silently swallowed as a parse error', !(err instanceof (await import('../server/llm.mjs')).LLMMalformed));
}

console.log(pass.map(s => '  PASS  ' + s).join('\n'));
if (fail.length) console.log('\n' + fail.map(s => '  FAIL  ' + s).join('\n'));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
