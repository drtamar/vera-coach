/**
 * The studio, driven in a real browser.
 *
 * Covers the two failure modes that used to be silent:
 *   - a browser with no speech recognition quietly lost the drills that check
 *     pace, filler words and hedging, with nothing saying why
 *   - a reload between the baseline and the drill discarded the measurement the
 *     whole bracketing exists to capture
 *
 * Skips cleanly when playwright is absent.
 */
import { spawn } from 'node:child_process';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  console.log('  SKIP  playwright not installed (npm i)');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

const PORT = 4191;
const PAGE = `http://127.0.0.1:${PORT}/studio/index.html`;
const server = spawn('node', [new URL('../sandbox/serve.mjs', import.meta.url).pathname],
  { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const stop = () => { try { server.kill(); } catch {} };
process.on('exit', stop);

const KEY = 'vera.studio.v1';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const R = [];
const t = (n, ok, x = '') => R.push(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  ' + x}`);
const errs = [];

async function open({ asr, storage } = {}) {
  const c = await b.newContext({ viewport: { width: 1000, height: 900 }, permissions: ['microphone'] });
  await c.addInitScript(({ asr, storage, KEY }) => {
    if (asr === false) {
      Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });
      Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });
    }
    // seed once per context, so a later reload keeps whatever the page itself wrote
    if (storage && !sessionStorage.getItem('seeded')) {
      localStorage.setItem(KEY, JSON.stringify(storage));
      sessionStorage.setItem('seeded', '1');
    }
  }, { asr, storage, KEY });
  const p = await c.newPage();
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
  await p.goto(PAGE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  await p.click('[data-v="drills"]');
  return { c, p };
}
const drillBlock = (p, name) => p.locator('.drill', { hasText: name });

/* ---------- 1. no speech recognition ---------- */
{
  const { c, p } = await open({ asr: false });
  const note = await p.textContent('#asrNote');
  t('no ASR: the page says why pace/filler/hedge drills are gone', /cannot transcribe speech/i.test(note), note);
  for (const name of ['No-Tailgating', 'Hedge-Word Ban']) {
    const d = drillBlock(p, name);
    t(`no ASR: ${name} has no Run button`, (await d.locator('[data-run]').count()) === 0);
    t(`no ASR: ${name} blames speech recognition, not the camera`,
      /speech recognition/i.test(await d.textContent()) && !/Needs the camera/.test(await d.textContent()));
  }
  t('no ASR: a drill that needs no transcript still runs', (await drillBlock(p, 'Melodic Staircase').locator('[data-run]').count()) === 1);
  const yap = await drillBlock(p, 'Yap Protocol').textContent();
  t('no ASR: a drill blocked by an uncomputed metric says so instead of blaming the camera',
    /not computed by this studio/i.test(yap) && /speech recognition/i.test(yap), yap.slice(-200));
  const gaze = await drillBlock(p, 'Monocular Lens').textContent();
  t('no ASR: a genuinely visual drill still says it needs the camera', /Needs the camera/.test(gaze), gaze.slice(-160));
  await c.close();
}

/* ---------- 2. speech recognition present ---------- */
{
  const { c, p } = await open({ asr: true });
  await p.evaluate(() => {});   // chromium exposes webkitSpeechRecognition natively
  const has = await p.evaluate(() => !!(window.SpeechRecognition || window.webkitSpeechRecognition));
  if (has) {
    t('ASR present: no warning is shown', (await p.textContent('#asrNote')).trim() === '');
    t('ASR present: No-Tailgating is runnable', (await drillBlock(p, 'No-Tailgating').locator('[data-run]').count()) === 1);
  } else {
    console.log('  note  this chromium has no Web Speech; the present-case checks were skipped');
  }
  await c.close();
}

/* ---------- 3. a reload between baseline and drill keeps the baseline ---------- */
{
  const now = Date.now();
  const seeded = (over = {}) => ({ drills: {}, turns: [], takes: [], efficacy: {},
    activeRun: { drillId: '3.1', phase: 'baseline', pre: { pitch_semitone_sd: 2.2, silence_ratio: .12 }, post: null, at: now, ...over } });

  let { c, p } = await open({ storage: seeded() });
  let banner = await p.textContent('#resumeBanner');
  t('resume: an unfinished session is offered', /Unfinished session/.test(banner) && /Melodic Staircase/.test(banner), banner);
  t('resume: it says the in-flight take was not kept', /not kept/.test(banner));
  await p.click('#resumeBtn');
  t('resume: the run card reopens on the right drill', /Melodic Staircase/.test(await p.textContent('#runName')));
  t('resume: it continues at the drill, not at the baseline', /Start the drill/.test(await p.textContent('#phaseBtn')), await p.textContent('#phaseBtn'));
  t('resume: the banner goes away once resumed', (await p.textContent('#resumeBanner')).trim() === '');
  const kept = await p.evaluate(k => JSON.parse(localStorage.getItem(k)).activeRun, KEY);
  t('resume: the baseline is still stored', kept?.pre?.pitch_semitone_sd === 2.2, JSON.stringify(kept));
  await p.click('#abortBtn');
  t('cancel: cancelling clears the stored session',
    (await p.evaluate(k => JSON.parse(localStorage.getItem(k)).activeRun, KEY)) === null);
  await p.reload({ waitUntil: 'networkidle' }); await p.click('[data-v="drills"]');
  t('cancel: and it is not offered again after a reload', (await p.textContent('#resumeBanner')).trim() === '');
  await c.close();

  ({ c, p } = await open({ storage: seeded() }));
  await p.click('#discardBtn');
  t('discard: removes the banner', (await p.textContent('#resumeBanner')).trim() === '');
  t('discard: and the stored session',
    (await p.evaluate(k => JSON.parse(localStorage.getItem(k)).activeRun, KEY)) === null);
  await c.close();

  ({ c, p } = await open({ storage: seeded({ at: now - 7 * 3600 * 1000 }) }));
  t('stale: a baseline older than the age limit is not offered', (await p.textContent('#resumeBanner')).trim() === '');
  t('stale: and is cleared rather than left to linger',
    (await p.evaluate(k => JSON.parse(localStorage.getItem(k)).activeRun, KEY)) === null);
  await c.close();

  ({ c, p } = await open({ storage: seeded({ drillId: '1.1' }) }));
  t('unrunnable: a drill this device cannot measure is not resumed', (await p.textContent('#resumeBanner')).trim() === '');
  await c.close();

  ({ c, p } = await open({ storage: { ...seeded(), activeRun: { garbage: true } } }));
  t('corrupt: junk in storage does not break the page', (await p.textContent('#resumeBanner')).trim() === '');
  await c.close();
}

/* ---------- 4. the real flow: measure a baseline, reload, resume ---------- */
{
  const { c, p } = await open();
  await p.click('#drillList [data-run="3.1"]');
  t('flow: starting a run stores nothing worth resuming yet',
    (await p.evaluate(k => JSON.parse(localStorage.getItem(k)).activeRun.phase, KEY)) === 'idle');
  await p.click('#phaseBtn');
  await p.waitForTimeout(21500);                       // the 20s baseline, against the fake microphone
  const btn = await p.textContent('#phaseBtn');
  const stored = await p.evaluate(k => JSON.parse(localStorage.getItem(k)).activeRun, KEY);
  t('flow: the baseline is stored the moment it completes', stored?.phase === 'baseline' && !!stored.pre, JSON.stringify(stored)?.slice(0, 160));
  t('flow: and the page offers the drill next', /Start the drill/.test(btn), btn);
  await p.reload({ waitUntil: 'networkidle' }); await p.waitForTimeout(400);
  await p.click('[data-v="drills"]');
  const banner = await p.textContent('#resumeBanner');
  t('flow: after a reload the session is offered back', /Melodic Staircase/.test(banner) && /baseline recorded/.test(banner), banner);
  await p.click('#resumeBtn');
  t('flow: and resumes at the drill', /Start the drill/.test(await p.textContent('#phaseBtn')));
  await c.close();
}

t('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await b.close();
console.log(R.join('\n'));
const f = R.filter(r => r.includes('FAIL')).length;
console.log(`\n${R.length - f} passed, ${f} failed`);
stop();
process.exit(f ? 1 : 0);
