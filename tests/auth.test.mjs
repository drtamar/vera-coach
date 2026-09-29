import {
  PLATFORMS, AUTH_MODES, buildClient, detectCredential, resolveModel,
  assertSupports, searchToolFor, describeConfig, AuthError, PlatformUnsupported,
} from '../server/auth.mjs';
import { researchTechnique } from '../server/research.mjs';
import { readFileSync } from 'node:fs';

const pass = [], fail = [];
const t = (n, c, extra='') => (c ? pass : fail).push(n + (c ? '' : `  ${extra}`));
const registry = JSON.parse(readFileSync(new URL('../registry/drills.json', import.meta.url)));

const fakeSDK = { default: class { constructor(o) { this.opts = o; } } };
const importer = () => Promise.resolve(fakeSDK);
const bedrockSDK = { AnthropicBedrockMantle: class { constructor(o) { this.opts = o; } } };
const vertexSDK  = { AnthropicVertex:        class { constructor(o) { this.opts = o; } } };

/* ---------- platform capability table ---------- */
t('platforms: all five are described', Object.keys(PLATFORMS).length === 5);
t('platforms: Bedrock has no web search', PLATFORMS.bedrock.webSearch === false);
t('platforms: Bedrock prefixes model ids', PLATFORMS.bedrock.modelPrefix === 'anthropic.');
t('platforms: first-party gets the dynamic-filtering search tool',
  PLATFORMS.anthropic.searchTool === 'web_search_20260209');
t('platforms: Vertex is pinned to the basic search variant',
  PLATFORMS.vertex.searchTool === 'web_search_20250305');
t('platforms: Foundry is pinned to the basic variant too (Azure-hosted is basic-only)',
  PLATFORMS.foundry.searchTool === 'web_search_20250305');

/* ---------- model id mapping ---------- */
t('model: bare id on first-party', resolveModel('claude-opus-5-5', 'anthropic') === 'claude-opus-5-5');
t('model: prefixed on Bedrock', resolveModel('claude-opus-5-5', 'bedrock') === 'anthropic.claude-opus-5-5');
t('model: prefix is not doubled', resolveModel('anthropic.claude-opus-5-5', 'bedrock') === 'anthropic.claude-opus-5-5');
t('model: bare id on Vertex', resolveModel('claude-opus-5-5', 'vertex') === 'claude-opus-5-5');
t('model: unknown platform throws', (() => { try { resolveModel('x', 'nope'); return false; } catch (e) { return e instanceof AuthError; } })());

/* ---------- feature gating ---------- */
t('gate: web search allowed on first-party', assertSupports('anthropic', 'web_search') === true);
t('gate: web search refused on Bedrock', (() => {
  try { assertSupports('bedrock', 'web_search'); return false; }
  catch (e) { return e instanceof PlatformUnsupported && e.platform === 'bedrock'; }
})());
t('gate: the refusal explains itself', (() => {
  try { searchToolFor('bedrock'); return false; }
  catch (e) { return e.message.includes('not available on Amazon Bedrock'); }
})());

/* ---------- research refuses on an unsupported platform, before any call ---------- */
{
  let called = false;
  const client = { messages: { create: async () => { called = true; return {}; } } };
  const r = await researchTechnique({ metric: 'wpm', registry, platform: 'bedrock', client });
  t('research: refuses on Bedrock', !r.ok && r.unsupported);
  t('research: refuses before making any API call', !called);
  t('research: the reason names the platform', r.errors[0].includes('Amazon Bedrock'));
}

/* ---------- credential detection and the shadowing trap ---------- */
{
  const c = detectCredential({ ANTHROPIC_API_KEY: 'sk-x' });
  t('credential: api key detected', c.source === 'api_key');
  t('credential: warns that a key outranks a profile', c.shadows !== null);
}
t('credential: auth token detected', detectCredential({ ANTHROPIC_AUTH_TOKEN: 'x' }).source === 'auth_token');
t('credential: key outranks token', detectCredential({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't' }).source === 'api_key');
t('credential: profile detected', detectCredential({ ANTHROPIC_PROFILE: 'work' }).source === 'oauth');
t('credential: key outranks profile', detectCredential({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_PROFILE: 'work' }).source === 'api_key');
{
  const wif = {
    ANTHROPIC_FEDERATION_RULE_ID: 'r', ANTHROPIC_ORGANIZATION_ID: 'o',
    ANTHROPIC_SERVICE_ACCOUNT_ID: 's', ANTHROPIC_IDENTITY_TOKEN_FILE: '/tmp/t',
  };
  t('credential: federation detected when complete', detectCredential(wif).source === 'workload_identity');
  const partial = { ...wif }; delete partial.ANTHROPIC_SERVICE_ACCOUNT_ID;
  t('credential: incomplete federation is not claimed', detectCredential(partial).source !== 'workload_identity');
}
{
  const none = detectCredential({});
  t('credential: nothing found is reported honestly', none.source === null);
  t('credential: and suggests a remedy', none.hint.includes('ant auth login'));
  const onDisk = detectCredential({ HOME: '/home/u' }, { existsSync: p => p === '/home/u/.config/anthropic' });
  t('credential: a profile on disk is found when nothing else is set', onDisk.source === 'oauth');
}

/* ---------- explicit modes fail loudly rather than falling through ---------- */
{
  let threw = null;
  try { await buildClient({ mode: 'api_key', env: {}, importer }); } catch (e) { threw = e; }
  t('mode api_key: errors when no key is present', threw instanceof AuthError);
  t('mode api_key: says how to fix it', threw.hint.includes('ANTHROPIC_API_KEY'));
}
{
  const r = await buildClient({ mode: 'api_key', apiKey: 'sk-test', env: {}, importer });
  t('mode api_key: constructs with an explicit key', r.client.opts.apiKey === 'sk-test');
}
{
  let threw = null;
  try { await buildClient({ mode: 'oauth', env: { ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_PROFILE: 'work' }, importer }); }
  catch (e) { threw = e; }
  t('mode oauth: refuses when a key would silently outrank the profile', threw instanceof AuthError);
  t('mode oauth: the message names the actual problem', threw.message.includes('outrank'));
}
{
  const r = await buildClient({ mode: 'oauth', env: { ANTHROPIC_PROFILE: 'work' }, importer });
  t('mode oauth: constructs with no explicit key', r.client.opts === undefined);
  t('mode oauth: reports the credential in use', r.credential.source === 'oauth');
}
{
  let threw = null;
  try { await buildClient({ mode: 'workload_identity', env: { ANTHROPIC_PROFILE: 'p' }, importer }); } catch (e) { threw = e; }
  t('mode workload_identity: refuses when a profile outranks federation', threw instanceof AuthError);
}
{
  let threw = null;
  try { await buildClient({ mode: 'nonsense', env: {}, importer }); } catch (e) { threw = e; }
  t('mode: an unknown mode is rejected', threw instanceof AuthError && threw.hint.includes('auto'));
}
{
  const r = await buildClient({ mode: 'auto', env: { ANTHROPIC_API_KEY: 'k' }, importer });
  t('mode auto: leaves resolution to the SDK', r.client instanceof fakeSDK.default);
  t('mode auto: still reports what will actually be used', r.credential.source === 'api_key');
}

/* ---------- provider clients ---------- */
{
  const r = await buildClient({ platform: 'bedrock', region: 'us-east-1', env: {}, importer: () => Promise.resolve(bedrockSDK) });
  t('bedrock: uses the Mantle client', r.client.constructor.name === 'AnthropicBedrockMantle');
  t('bedrock: passes the region', r.client.opts.awsRegion === 'us-east-1');
  let threw = null;
  try { await buildClient({ platform: 'bedrock', env: {}, importer: () => Promise.resolve(bedrockSDK) }); } catch (e) { threw = e; }
  t('bedrock: a missing region is a clear error', threw instanceof AuthError && threw.message.includes('AWS region'));
}
{
  const r = await buildClient({ platform: 'vertex', projectId: 'p1', env: {}, importer: () => Promise.resolve(vertexSDK) });
  t('vertex: passes project id', r.client.opts.projectId === 'p1');
  t('vertex: defaults region to global', r.client.opts.region === 'global');
}
{
  let threw = null;
  try { await buildClient({ platform: 'vertex', env: {}, importer: () => Promise.reject(new Error('no pkg')) }); } catch (e) { threw = e; }
  t('sdk: a missing provider package names the package to install',
    threw instanceof AuthError && threw.hint.includes('@anthropic-ai/vertex-sdk'));
}

/* ---------- config summary ---------- */
{
  const d = describeConfig({ platform: 'anthropic', env: { ANTHROPIC_API_KEY: 'k' } });
  t('describe: reports research as available on first-party', d.research.includes('available'));
  t('describe: surfaces the shadow warning', d.shadowWarning !== null);
  const b = describeConfig({ platform: 'bedrock', env: {} });
  t('describe: reports research unavailable on Bedrock', b.research.includes('unavailable'));
  t('describe: generation stays available on Bedrock', b.generation === 'available');
  t('describe: names the platform', b.label === 'Amazon Bedrock');
}

t('modes: the four supported modes are enumerated', AUTH_MODES.length === 4 && AUTH_MODES.includes('auto'));

console.log(pass.map(s => '  PASS  ' + s).join('\n'));
if (fail.length) console.log('\n' + fail.map(s => '  FAIL  ' + s).join('\n'));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
