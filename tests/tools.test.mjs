import { TOOLS, validateProposedDrill } from '../server/tools.mjs';
import { readFileSync } from 'node:fs';

const pass = [], fail = [];
const t = (n, c, extra='') => (c ? pass : fail).push(n + (c ? '' : `  ${extra}`));

const reg = JSON.parse(readFileSync(new URL('../registry/drills.json', import.meta.url)));
const METRICS = Object.keys(reg.metrics);

t('tools: all eight are defined', TOOLS.length === 8, `${TOOLS.length}`);
for (const name of ['analyze_multimodal_stream','configure_teleprompter','trigger_realtime_haptic_nudge',
                    'inject_live_disruption','generate_diagnostic_scorecard',
                    'record_efficacy','propose_drill','research_technique']) {
  t(`tools: ${name} present`, TOOLS.some(x => x.name === name));
}
t('tools: every tool has a description and schema',
  TOOLS.every(x => x.description && x.parameters?.type === 'object'));
t('tools: analyze feature enum matches the documented eight dimensions', (() => {
  const e = TOOLS.find(x => x.name === 'analyze_multimodal_stream').parameters.properties.features.items.enum;
  return e.length === 8 && e.every(m => METRICS.includes(m));
})());
t('tools: teleprompter column width holds the 30-45 saccade range', (() => {
  const p = TOOLS.find(x => x.name === 'configure_teleprompter').parameters.properties.column_width_chars;
  return p.minimum === 30 && p.maximum === 45;
})());

/* proposed-drill validation is the gate on generated and researched content */
{
  const good = { name: 'X', target_metrics: ['wpm'], graduation: { wpm: { op: 'between', value: [130,150] } },
                 duration_s: 60, coach_brief: 'brief', protocol: ['do the thing'] };
  t('validate: a well-formed proposal passes', validateProposedDrill(good, METRICS).ok);
  t('validate: unknown metric is rejected',
    !validateProposedDrill({ ...good, target_metrics: ['vibes'] }, METRICS).ok);
  t('validate: missing graduation is rejected',
    !validateProposedDrill({ ...good, graduation: {} }, METRICS).ok);
  t('validate: bad operator is rejected',
    !validateProposedDrill({ ...good, graduation: { wpm: { op: '~=', value: 1 } } }, METRICS).ok);
  t('validate: between without a range is rejected',
    !validateProposedDrill({ ...good, graduation: { wpm: { op: 'between', value: 5 } } }, METRICS).ok);
  t('validate: empty protocol is rejected', !validateProposedDrill({ ...good, protocol: [] }, METRICS).ok);
  t('validate: zero duration is rejected', !validateProposedDrill({ ...good, duration_s: 0 }, METRICS).ok);
  t('validate: null input does not throw', validateProposedDrill(null, METRICS).ok === false);
  t('validate: errors are enumerated', validateProposedDrill({}, METRICS).errors.length >= 4);
}

console.log(pass.map(s => '  PASS  ' + s).join('\n'));
if (fail.length) console.log('\n' + fail.map(s => '  FAIL  ' + s).join('\n'));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
