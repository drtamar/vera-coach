#!/usr/bin/env node
/**
 * Connect this installation to a Claude account.
 *
 *   node bin/connect.mjs              inspect and guide
 *   node bin/connect.mjs --verify     also prove the credential works
 *   node bin/connect.mjs --json       machine-readable, for CI
 *
 * Verification uses the Models API, which is a read: it proves the credential
 * is live without spending a single inference token.
 */

import { detectCredential, describeConfig, buildClient, PLATFORMS, AUTH_MODES, defaultProfilePath } from '../server/auth.mjs';
import { existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const platform = val('--platform', 'anthropic');
const mode = val('--mode', 'auto');
const asJSON = has('--json');
const doVerify = has('--verify');

const C = {
  dim: s => asJSON ? s : `\x1b[2m${s}\x1b[0m`,
  bold: s => asJSON ? s : `\x1b[1m${s}\x1b[0m`,
  ok: s => asJSON ? s : `\x1b[32m${s}\x1b[0m`,
  warn: s => asJSON ? s : `\x1b[33m${s}\x1b[0m`,
  err: s => asJSON ? s : `\x1b[31m${s}\x1b[0m`,
};

if (has('--help') || has('-h')) {
  console.log(`
Connect VERA to a Claude account.

  --platform <${Object.keys(PLATFORMS).join('|')}>   default: anthropic
  --mode <${AUTH_MODES.join('|')}>          default: auto
  --verify                                  prove the credential works (free — Models API)
  --json                                    machine-readable output
`);
  process.exit(0);
}

if (!PLATFORMS[platform]) {
  console.error(C.err(`Unknown platform "${platform}". Choose one of: ${Object.keys(PLATFORMS).join(', ')}`));
  process.exit(2);
}

const cred = detectCredential(process.env, { existsSync });
const cfg = describeConfig({ platform, mode });
const result = { platform, mode, ...cfg, verified: null, models: null, problems: [] };

/* ---------- no credential: explain both routes ---------- */
if (!cred.source) {
  result.problems.push('no credential found');
  if (asJSON) { console.log(JSON.stringify(result, null, 2)); process.exit(1); }

  console.log(`\n${C.bold('Not connected.')} Two ways to fix that:\n`);
  console.log(`${C.bold('1. Connect an account')} ${C.dim('(recommended — no secret to store or rotate)')}`);
  console.log(`   ${C.dim('$')} npm i -g @anthropic-ai/ant`);
  console.log(`   ${C.dim('$')} ant auth login`);
  console.log(`   ${C.dim(`Writes a profile to ${defaultProfilePath()}. The SDK finds it with no env var set.`)}\n`);
  console.log(`${C.bold('2. Use an API key')}`);
  console.log(`   ${C.dim('$')} export ANTHROPIC_API_KEY=sk-ant-...`);
  console.log(`   ${C.dim('Get one at console.anthropic.com. Prefer this for servers and CI.')}\n`);
  console.log(`${C.dim('Then re-run with --verify.')}\n`);
  process.exit(1);
}

/* ---------- connected: report, and flag the shadowing trap ---------- */
if (!asJSON) {
  console.log(`\n${C.bold('Platform')}  ${cfg.label}`);
  console.log(`${C.bold('Credential')}  ${C.ok(cred.source)} ${C.dim(`(${cred.detail})`)}`);
  if (cfg.shadowWarning) {
    console.log(`\n${C.warn('Note')}  ${cfg.shadowWarning}`);
    console.log(C.dim('      If you meant to use a connected account, unset that variable.'));
  }
  console.log(`\n${C.bold('Generation')}  ${cfg.generation}`);
  console.log(`${C.bold('Research')}    ${cfg.research.startsWith('available') ? C.ok(cfg.research) : C.warn(cfg.research)}`);
}

/* ---------- verify: a read, not an inference call ---------- */
if (doVerify) {
  try {
    const { client } = await buildClient({ platform, mode });
    const page = await client.models.list({ limit: 20 });
    const ids = (page?.data ?? []).map(m => m.id);
    result.verified = true;
    result.models = ids;
    if (!asJSON) {
      console.log(`\n${C.ok('Verified.')} ${C.dim(`The credential is live — ${ids.length} models visible.`)}`);
      const target = 'claude-opus-5-5';
      if (ids.length && !ids.includes(target)) {
        console.log(C.warn(`\nWarning  ${target} is not in this account's model list.`));
        console.log(C.dim(`         Visible: ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ', …' : ''}`));
        result.problems.push(`${target} not available to this account`);
      }
    }
  } catch (err) {
    result.verified = false;
    result.problems.push(err.message);
    if (asJSON) { console.log(JSON.stringify(result, null, 2)); process.exit(1); }
    console.log(`\n${C.err('Verification failed.')} ${err.message}`);
    if (err.hint) console.log(C.dim(`  ${err.hint}`));
    if (/not installed/i.test(err.message)) console.log(C.dim(`  $ npm i ${PLATFORMS[platform].pkg}`));
    process.exit(1);
  }
}

if (asJSON) console.log(JSON.stringify(result, null, 2));
else if (!doVerify) console.log(C.dim('\nRe-run with --verify to prove the credential works (free — no tokens spent).\n'));
else console.log('');

process.exit(result.problems.length && result.verified === false ? 1 : 0);
