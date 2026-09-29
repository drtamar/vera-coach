/**
 * Credential and platform selection.
 *
 * Two independent choices live here. WHERE Claude runs — the first-party API,
 * Claude Platform on AWS, Bedrock, Vertex or Foundry — and HOW you authenticate
 * to it. They interact, because not every platform can do everything the
 * learning layer needs.
 *
 * The constraint that matters: web search, which tier-3 research depends on, is
 * NOT available on Bedrock, and Vertex and Azure-hosted Foundry only carry the
 * basic tool variant. Research therefore refuses on Bedrock with a clear reason
 * instead of failing later as an opaque 400.
 */

export const PLATFORMS = {
  /** First-party Claude API. Everything is available. */
  anthropic: {
    label: 'Claude API',
    pkg: '@anthropic-ai/sdk',
    webSearch: true,
    searchTool: 'web_search_20260209',
    modelPrefix: '',
  },
  /** Anthropic-operated, same-day API parity. */
  aws: {
    label: 'Claude Platform on AWS',
    pkg: '@anthropic-ai/sdk',
    webSearch: true,
    searchTool: 'web_search_20260209',
    modelPrefix: '',
  },
  /** Partner-operated. No web search at all — tier-3 research cannot run here. */
  bedrock: {
    label: 'Amazon Bedrock',
    pkg: '@anthropic-ai/bedrock-sdk',
    webSearch: false,
    searchTool: null,
    modelPrefix: 'anthropic.',
  },
  /** Basic search variant only — no dynamic filtering. */
  vertex: {
    label: 'Google Vertex AI',
    pkg: '@anthropic-ai/vertex-sdk',
    webSearch: true,
    searchTool: 'web_search_20250305',
    modelPrefix: '',
  },
  /** Azure-hosted Foundry is basic-only, so we take the variant that works everywhere. */
  foundry: {
    label: 'Microsoft Foundry',
    pkg: '@anthropic-ai/foundry-sdk',
    webSearch: true,
    searchTool: 'web_search_20250305',
    modelPrefix: '',
  },
};

export const AUTH_MODES = ['auto', 'api_key', 'oauth', 'workload_identity'];

export class AuthError extends Error {
  constructor(message, hint) { super(message); this.name = 'AuthError'; this.hint = hint; }
}
export class PlatformUnsupported extends Error {
  constructor(message, platform, feature) {
    super(message); this.name = 'PlatformUnsupported'; this.platform = platform; this.feature = feature;
  }
}

/**
 * Report which credential the SDK will actually use, in its resolution order.
 *
 * Worth surfacing rather than leaving implicit: an exported ANTHROPIC_API_KEY
 * silently outranks an `ant auth login` profile, so "I logged in but it's using
 * the wrong account" is a real and otherwise invisible failure.
 */
export function detectCredential(env = process.env, fs = null) {
  if (env.ANTHROPIC_API_KEY) {
    return { source: 'api_key', detail: 'ANTHROPIC_API_KEY is set', shadows: 'an OAuth profile, if one exists' };
  }
  if (env.ANTHROPIC_AUTH_TOKEN) {
    return { source: 'auth_token', detail: 'ANTHROPIC_AUTH_TOKEN is set', shadows: 'an OAuth profile, if one exists' };
  }
  if (env.ANTHROPIC_PROFILE) {
    return { source: 'oauth', detail: `ANTHROPIC_PROFILE=${env.ANTHROPIC_PROFILE}`, shadows: null };
  }
  const wif = ['ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_SERVICE_ACCOUNT_ID'];
  const token = env.ANTHROPIC_IDENTITY_TOKEN_FILE || env.ANTHROPIC_IDENTITY_TOKEN;
  if (wif.every(k => env[k]) && token) {
    return { source: 'workload_identity', detail: 'federation environment is complete', shadows: null };
  }
  if (fs?.existsSync?.(defaultProfilePath(env))) {
    return { source: 'oauth', detail: 'default profile on disk', shadows: null };
  }
  return {
    source: null,
    detail: 'no credential found',
    hint: 'Run `ant auth login`, or export ANTHROPIC_API_KEY.',
  };
}

export function defaultProfilePath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || '';
  return `${home}/.config/anthropic`;
}

/** Bedrock prefixes model ids; everywhere else takes the bare id. */
export function resolveModel(model, platform = 'anthropic') {
  const p = PLATFORMS[platform];
  if (!p) throw new AuthError(`Unknown platform "${platform}".`, `Choose one of: ${Object.keys(PLATFORMS).join(', ')}`);
  if (!p.modelPrefix || model.startsWith(p.modelPrefix)) return model;
  return p.modelPrefix + model;
}

/** Can this platform do what the caller is about to ask of it? */
export function assertSupports(platform, feature) {
  const p = PLATFORMS[platform];
  if (!p) throw new AuthError(`Unknown platform "${platform}".`);
  if (feature === 'web_search' && !p.webSearch) {
    throw new PlatformUnsupported(
      `Web search is not available on ${p.label}, so technique research cannot run there.`,
      platform, feature
    );
  }
  return true;
}

export function searchToolFor(platform) {
  const p = PLATFORMS[platform];
  assertSupports(platform, 'web_search');
  return p.searchTool;
}

/**
 * Build a client for the chosen platform and auth mode.
 *
 * `auto` leaves credential resolution to the SDK, which is right for most
 * deployments. The explicit modes exist so a deployment can *fail loudly*
 * rather than silently falling through to a credential its operator did not
 * intend — which is the failure this whole module is here to prevent.
 */
export async function buildClient({
  platform = 'anthropic',
  mode = 'auto',
  apiKey = null,
  region = null,
  projectId = null,
  resource = null,
  env = process.env,
  importer = spec => import(/* @vite-ignore */ spec),
} = {}) {
  const p = PLATFORMS[platform];
  if (!p) throw new AuthError(`Unknown platform "${platform}".`, `Choose one of: ${Object.keys(PLATFORMS).join(', ')}`);
  if (!AUTH_MODES.includes(mode)) throw new AuthError(`Unknown auth mode "${mode}".`, `Choose one of: ${AUTH_MODES.join(', ')}`);

  // Explicit modes are checked before we construct anything, so a
  // misconfiguration surfaces here rather than as a 401 mid-session.
  if (mode === 'api_key' && !apiKey && !env.ANTHROPIC_API_KEY) {
    throw new AuthError('Auth mode is "api_key" but no key was provided.', 'Pass apiKey, or export ANTHROPIC_API_KEY.');
  }
  if (mode === 'oauth') {
    if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
      throw new AuthError(
        'Auth mode is "oauth" but an API key or auth token is set, and those outrank the profile.',
        'Unset ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN, or switch mode to "auto".'
      );
    }
    const cred = detectCredential(env);
    if (cred.source !== 'oauth') {
      throw new AuthError('Auth mode is "oauth" but no profile was found.', 'Run `ant auth login`, or set ANTHROPIC_PROFILE.');
    }
  }
  if (mode === 'workload_identity') {
    if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE) {
      throw new AuthError(
        'Auth mode is "workload_identity" but a key, token or profile is set, and those all outrank federation.',
        'Unset ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_PROFILE.'
      );
    }
    if (detectCredential(env).source !== 'workload_identity') {
      throw new AuthError('Auth mode is "workload_identity" but the federation environment is incomplete.',
        'Set ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID, ANTHROPIC_SERVICE_ACCOUNT_ID and an identity token.');
    }
  }

  let mod;
  try {
    mod = await importer(p.pkg);
  } catch {
    throw new AuthError(`The ${p.label} SDK is not installed.`, `Run \`npm i ${p.pkg}\`.`);
  }

  const client = construct(mod, platform, { apiKey, region, projectId, resource, env });
  return { client, platform, capabilities: { ...p }, credential: detectCredential(env) };
}

function construct(mod, platform, { apiKey, region, projectId, resource, env }) {
  const need = (v, name, hint) => {
    if (!v) throw new AuthError(`${PLATFORMS[platform].label} requires ${name}.`, hint);
    return v;
  };
  switch (platform) {
    case 'anthropic':
    case 'aws': {
      const Anthropic = mod.default || mod.Anthropic;
      return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
    }
    case 'bedrock': {
      const { AnthropicBedrockMantle } = mod;
      return new AnthropicBedrockMantle({
        awsRegion: need(region || env.AWS_REGION, 'an AWS region', 'Pass region, or export AWS_REGION.'),
      });
    }
    case 'vertex': {
      const { AnthropicVertex } = mod;
      return new AnthropicVertex({
        projectId: need(projectId || env.GOOGLE_CLOUD_PROJECT, 'a GCP project id', 'Pass projectId, or export GOOGLE_CLOUD_PROJECT.'),
        region: region || env.GOOGLE_CLOUD_REGION || 'global',
      });
    }
    case 'foundry': {
      const AnthropicFoundry = mod.default || mod.AnthropicFoundry;
      return new AnthropicFoundry({
        apiKey: apiKey || env.ANTHROPIC_API_KEY,
        resource: need(resource || env.AZURE_FOUNDRY_RESOURCE, 'a Foundry resource', 'Pass resource, or export AZURE_FOUNDRY_RESOURCE.'),
      });
    }
    default:
      throw new AuthError(`Unknown platform "${platform}".`);
  }
}

/** Human-readable configuration summary, for a health endpoint or a startup log. */
export function describeConfig({ platform = 'anthropic', mode = 'auto', env = process.env } = {}) {
  const p = PLATFORMS[platform] || {};
  const cred = detectCredential(env);
  return {
    platform, label: p.label ?? 'unknown', authMode: mode,
    credentialSource: cred.source, credentialDetail: cred.detail,
    shadowWarning: cred.shadows ? `${cred.detail} — this outranks ${cred.shadows}.` : null,
    generation: 'available',
    research: p.webSearch ? `available (${p.searchTool})` : `unavailable — ${p.label} has no web search`,
  };
}
