/**
 * The only test that spends money. Not part of `npm test`.
 *
 *   VERA_LIVE=1 node tests/smoke-live.mjs
 *
 * Makes two real requests: one generation, and one research if the platform
 * supports web search. Requires a credential — an API key, or an `ant auth
 * login` profile.
 */
import { readFileSync } from 'node:fs';
import { describeConfig, detectCredential } from '../server/auth.mjs';
import { generateDrill } from '../server/generate.mjs';
import { researchTechnique } from '../server/research.mjs';
import { EfficacyModel } from '../app/learning/efficacy.mjs';

if (!process.env.VERA_LIVE) {
  console.log('Refusing to spend money without VERA_LIVE=1. See the header of this file.');
  process.exit(0);
}
const cred = detectCredential(process.env);
if (!cred.source) {
  console.error(`No credential found. ${cred.hint}`);
  process.exit(1);
}

const platform = process.env.VERA_PLATFORM || 'anthropic';
console.log('config:', JSON.stringify(describeConfig({ platform }), null, 2));

const registry = JSON.parse(readFileSync(new URL('../registry/drills.json', import.meta.url)));
const efficacy = new EfficacyModel();

console.log('\n--- tier 2: generation ---');
const gen = await generateDrill({ metric: 'wpm', registry, efficacy, telemetry: { wpm: 188 }, platform });
if (!gen.ok) { console.error('FAILED:', gen.errors); process.exitCode = 1; }
else {
  console.log('name:       ', gen.drill.name);
  console.log('targets:    ', gen.drill.target_metrics.join(', '));
  console.log('graduation: ', JSON.stringify(gen.drill.graduation));
  console.log('brief:      ', gen.drill.coach_brief);
  console.log('protocol:   ', gen.drill.protocol.map(s => '\n  - ' + s).join(''));
}

console.log('\n--- tier 3: research ---');
const res = await researchTechnique({ metric: 'terminal_pitch_slope', registry, telemetry: { terminal_pitch_slope: 1.8 }, platform });
if (res.unsupported) console.log('skipped:', res.errors[0]);
else if (!res.ok) { console.error('FAILED:', res.errors); process.exitCode = 1; }
else {
  console.log('name:    ', res.drill.name);
  console.log('sources: ', res.drill.provenance.sources.map(s => '\n  - ' + s.url).join(''));
  console.log('brief:   ', res.drill.coach_brief);
}
