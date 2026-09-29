/**
 * The sandbox, driven in a real browser.
 *
 * Boots the static server and exercises every panel. This matters because the
 * page imports the engine's REAL modules over HTTP rather than a bundled copy,
 * so a module that only works under Node — one touching `process.env` at import
 * time, say — breaks here and nowhere else.
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

const PORT = 4188;
const PAGE = `http://127.0.0.1:${PORT}/`;
const server = spawn('node', [new URL('../sandbox/serve.mjs', import.meta.url).pathname],
  { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const stop = () => { try { server.kill(); } catch {} };
process.on('exit', stop);

const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium' });
const p = await (await b.newContext({ viewport:{width:1100,height:900} })).newPage();
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
// Ignore resource-load noise: the webfont CDN is blocked behind some proxies and
// the page declares real fallback stacks. Script errors are what matter here.
p.on('console', m => { if (m.type()==='error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });

await p.goto(PAGE, { waitUntil:'networkidle' });
const R=[]; const t=(n,ok,x='')=>R.push(`  ${ok?'PASS':'FAIL'}  ${n}${ok?'':'  '+x}`);

const badge = await p.textContent('#srcBadge');
t('modules load in a browser (auth.mjs process.env does not break import)', badge.includes('live modules'), badge);
t('registry fetched', badge.includes('21 drills'), badge);

// scoring
await p.fill('#s-wpm', '200'); await p.dispatchEvent('#s-wpm','input'); await p.waitForTimeout(150);
const bad = await p.textContent('.stat.big .n');
await p.fill('#s-wpm', '140'); await p.dispatchEvent('#s-wpm','input'); await p.waitForTimeout(150);
const good = await p.textContent('.stat.big .n');
t('scoring: out-of-band telemetry lowers the composite', Number(bad) < Number(good), `${bad} vs ${good}`);
t('scoring: weakest metric surfaces', (await p.textContent('#scoreOut')).length > 40);

// learning
await p.click('[data-p="learn"]'); await p.click('#runSim'); await p.waitForTimeout(400);
const sim = await p.textContent('#simOut');
t('learning: simulation runs in-browser', sim.includes('works'));
t('learning: bandit converges on the effective drill', sim.includes('works ✓'), sim.slice(0,200));

// generation
await p.click('[data-p="generate"]'); await p.waitForTimeout(200);
const prompt = await p.textContent('#promptOut');
t('generation: real prompt rendered', prompt.includes('STALLED METRIC'));
t('generation: prompt carries measured effects', prompt.includes('ALREADY TRIED'));
await p.click('[data-gen="clean"]'); await p.waitForTimeout(300);
t('generation: clean candidate accepted', (await p.textContent('#genOut')).includes('ACCEPTED'));
for (const [v,label] of [['offtarget','wrong metric'],['vacuous','vacuous bar'],['nocues','no cues']]) {
  await p.click(`[data-gen="${v}"]`); await p.waitForTimeout(300);
  t(`generation: ${label} rejected`, (await p.textContent('#genOut')).includes('REJECTED'));
}

// research — the injection panel
await p.click('[data-p="research"]'); await p.waitForTimeout(200);
await p.click('[data-res="clean"]'); await p.waitForTimeout(300);
t('research: legitimate source accepted', (await p.textContent('#resOut')).includes('ACCEPTED'));
for (const [v,label] of [['vacuous','vacuous threshold'],['link','smuggled URL'],['cue','URL in cue'],['nosrc','cites nothing']]) {
  await p.click(`[data-res="${v}"]`); await p.waitForTimeout(300);
  const o = await p.textContent('#resOut');
  t(`research: ${label} rejected`, o.includes('REJECTED'), o.slice(0,140));
}

// registry
await p.click('[data-p="registry"]'); await p.waitForTimeout(200);
const reg = await p.textContent('#regOut');
t('registry: all drills rendered', (await p.locator('.drill').count()) === 21);
t('registry: no curriculum bar flagged out of range', !reg.includes('BAR OUT OF RANGE'));

// themes + layout
for (const s of ['light','dark']) {
  const c = await b.newContext({ colorScheme:s, viewport:{width:375,height:800} });
  const q = await c.newPage(); await q.goto(PAGE, { waitUntil:'networkidle' });
  const bg = await q.evaluate(()=>getComputedStyle(document.body).backgroundColor);
  t(`${s}: background painted`, bg !== 'rgba(0, 0, 0, 0)', bg);
  t(`${s}: no horizontal scroll at 375px`, await q.evaluate(()=>document.documentElement.scrollWidth) <= 375);
  await c.close();
}

t('no page errors', errs.length === 0, errs.slice(0,3).join(' | '));
await b.close();
console.log(R.join('\n'));
const f = R.filter(r=>r.includes('FAIL')).length;
console.log(`\n${R.length-f} passed, ${f} failed`);
stop();
process.exit(f?1:0);
