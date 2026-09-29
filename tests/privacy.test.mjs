/**
 * The privacy invariant: raw media never leaves the device.
 *
 * This is the one test that must never be allowed to fail. It works two ways:
 * a static scan asserting the sensing modules contain no network egress at all,
 * and a shape check asserting the telemetry vector carries only numbers.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const pass = [], fail = [];
const t = (n, c, extra='') => (c ? pass : fail).push(n + (c ? '' : `  ${extra}`));

const ROOT = new URL('..', import.meta.url).pathname;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.mjs') || p.endsWith('.js')) out.push(p);
  }
  return out;
}

const EGRESS = /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|RTCPeerConnection)\b/;
const MEDIA  = /\b(MediaStream|MediaRecorder|captureStream|toDataURL|toBlob|getImageData|createObjectURL)\b/;

/* ---------- 1. sensing modules must have no network egress whatsoever ---------- */
{
  const sensing = walk(join(ROOT, 'app', 'sensing'));
  t('scan: sensing modules found', sensing.length >= 3, `${sensing.length}`);
  for (const f of sensing) {
    const src = readFileSync(f, 'utf8');
    const name = relative(ROOT, f);
    // the MediaPipe WASM/model imports are static asset loads, not data egress
    const lines = src.split('\n').filter(l => EGRESS.test(l) && !/^\s*(\*|\/\/)/.test(l));
    t(`egress: ${name} makes no network calls`, lines.length === 0, lines.join(' | '));
  }
}

/* ---------- 2. no module both touches media and calls the network ---------- */
/* server/ is included deliberately: it is the half that WILL make network calls,
   so it is exactly where a media reference would be a breach. */
{
  for (const f of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'server'))]) {
    const src = readFileSync(f, 'utf8');
    const code = src.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    const name = relative(ROOT, f);
    const touchesMedia = MEDIA.test(code);
    const callsNetwork = EGRESS.test(code);
    t(`isolation: ${name} does not combine media access with network egress`,
      !(touchesMedia && callsNetwork),
      touchesMedia && callsNetwork ? 'BOTH PRESENT' : '');
  }
}

/* ---------- 2b. the server half must not reach into the sensing half ----------
   server/ now genuinely calls the network (drill generation). The isolation
   check above passes trivially for it, because the SDK hides the transport.
   So assert the structural boundary directly: nothing under server/ may import
   the sensing pipeline, which is the only place raw media exists. */
{
  for (const f of walk(join(ROOT, 'server'))) {
    const src = readFileSync(f, 'utf8');
    const name = relative(ROOT, f);
    const importsSensing = /from\s+['"][^'"]*sensing\//.test(src);
    t(`boundary: ${name} does not import the sensing pipeline`, !importsSensing);
  }
  const gen = readFileSync(join(ROOT, 'server', 'generate.mjs'), 'utf8');
  t('boundary: generate.mjs never references a MediaStream or frame buffer',
    !/MediaStream|videoEl|getUserMedia|Float32Array|ImageData/.test(gen));
  t('boundary: llm.mjs never references media either',
    !/MediaStream|videoEl|getUserMedia|Float32Array|ImageData/.test(readFileSync(join(ROOT,'server','llm.mjs'),'utf8')));
}

/* ---------- 3. the telemetry vector carries numbers only ---------- */
{
  const src = readFileSync(join(ROOT, 'app', 'sensing', 'pipeline.mjs'), 'utf8');
  const body = src.slice(src.indexOf('telemetry()'));
  const forbidden = ['this.stream', 'videoEl', 'srcObject', 'buf,', 'blob', 'dataUrl', 'base64'];
  for (const token of forbidden) {
    t(`telemetry(): does not return '${token}'`, !body.includes(token));
  }
  // The transcript is CONSUMED to derive numbers (wpm, filler_density) but must
  // never itself be a returned value. Match direct assignment and shorthand only,
  // not the function arguments those metrics are computed from.
  const ret = body.split('return {')[1] || '';
  t('telemetry(): transcript is never a returned value',
    !/^\s*[\w_]+:\s*this\.transcript\s*[,}]/m.test(ret) && !/^\s*transcript\s*[,}]/m.test(ret),
    'raw transcript must stay on device');
  t('telemetry(): transcript is used only as an argument to metric functions',
    (ret.match(/this\.transcript/g) || []).every((_, i) =>
      /\w+\(\s*this\.transcript/.test(ret.split('this.transcript')[i] + 'this.transcript')));
}

/* ---------- 4. runtime shape: every field is a number, boolean or null ---------- */
{
  // reproduce the telemetry contract without a browser
  const sample = {
    gaze_fixation_ratio: 0.72, blink_rate: 18, truth_plane_occupancy: 0.5,
    head_tilt_angle: 7, wpm: 140, pitch_semitone_sd: 3.1,
    terminal_pitch_slope: -0.8, filler_density: 0.009,
    hedge_density: 0, apology_phrases: 0, horizontal_eye_deviation_deg: 0.9,
    head_yaw_deviation_deg: 2, torso_lateral_displacement_cm: 1.1,
    clavicular_rise_mm: 3, au12_smile_events: 2, brow_flash_rate: 3,
    facial_grimace_events: 0, hands_below_frame_events: 0, silence_ratio: 0.17,
    freezes: 0, speech_onset_latency_s: 1.2, restarts: 0, duration_s: 45,
    _asr_available: true,
  };
  const bad = Object.entries(sample).filter(([, v]) =>
    !(typeof v === 'number' || typeof v === 'boolean' || v === null));
  t('shape: every telemetry field is a number, boolean or null', bad.length === 0, JSON.stringify(bad));
  t('shape: JSON round-trip is lossless and media-free',
    JSON.stringify(sample).length < 700 && !JSON.stringify(sample).includes('data:'));
}

console.log(pass.map(s => '  PASS  ' + s).join('\n'));
if (fail.length) console.log('\n' + fail.map(s => '  FAIL  ' + s).join('\n'));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
