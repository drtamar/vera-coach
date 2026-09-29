import { chromium } from 'playwright';

const ONRAMP = new URL('../onramp/index.html', import.meta.url).href;
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium' });
const ok=[],bad=[];
const t=(n,c)=>c?ok.push(n):bad.push(n);

for (const scheme of ['light','dark']) {
  const ctx = await b.newContext({ colorScheme:scheme, viewport:{width:375,height:780} });
  const p = await ctx.newPage();
  p.on('pageerror', e => bad.push('JS error: '+e.message));
  await p.goto(ONRAMP);
  await p.waitForTimeout(400);

  const bg = await p.evaluate(()=>getComputedStyle(document.body).backgroundColor);
  const fg = await p.evaluate(()=>getComputedStyle(document.body).color);
  t(`${scheme}: body bg painted (${bg})`, bg!=='rgba(0, 0, 0, 0)');
  const lum = s => { const [r,g,bl]=s.match(/\d+/g).map(Number); return .2126*r+.7152*g+.0722*bl; };
  t(`${scheme}: text/bg contrast sane`, Math.abs(lum(bg)-lum(fg)) > 110);

  const sw = await p.evaluate(()=>document.documentElement.scrollWidth);
  t(`${scheme}: no horizontal scroll at 375px (${sw})`, sw<=375);
  await ctx.close();
}

// interaction pass
const ctx = await b.newContext({ viewport:{width:390,height:840} });
const p = await ctx.newPage();
p.on('pageerror', e => bad.push('JS error: '+e.message));
await p.goto(ONRAMP);

t('starts at Standby', (await p.textContent('#recLabel'))==='Standby');
t('goal is 57 reps', (await p.textContent('#meterRead')).includes('of 57'));

// log a rep
await p.click('[data-log="e1"]');
t('rec dot flips to Rec after first rep', (await p.textContent('#recLabel'))==='Rec');
t('meter counts the rep', (await p.textContent('#meterRead')).startsWith('1 of 57'));

// froze path
p.once('dialog', d => d.accept('went blank immediately'));
await p.click('[data-froze="e1"]');
await p.waitForTimeout(250);
t('froze rep recorded but meter caps at target', (await p.textContent('#meterRead')).startsWith('1 of 57'));
t('overshot exercise shows capped count, not 2 / 1', (await p.textContent('[data-stage="s0"] .ex-count'))==='1 / 1');
t('froze counter shows', (await p.textContent('#frozeRead')).includes('1 froze rep'));
t('froze log records the note', (await p.textContent('#logBody')).includes('went blank immediately'));

// tap targets
const small = await p.evaluate(()=>[...document.querySelectorAll('.btn')]
  .filter(b=>b.offsetParent && b.getBoundingClientRect().height<44).length);
t('all visible buttons >=44px tall', small===0);

// persistence
await p.reload(); await p.waitForTimeout(300);
t('reps survive reload', (await p.textContent('#meterRead')).startsWith('1 of 57'));
t('froze log survives reload', (await p.textContent('#logBody')).includes('went blank immediately'));

// timer
await p.click('[data-toggle="s1"]'); await p.waitForTimeout(250);
await p.click('[data-timer="e4"]'); await p.waitForTimeout(1400);
const clock = await p.textContent('#clock');
t(`timer counts down (${clock})`, clock!=='1:00' && clock.startsWith('0:5'));
await p.keyboard.press('Escape'); await p.waitForTimeout(250);
t('Escape closes timer', !(await p.isVisible('#veil.up')));

// blocked storage
const ctx2 = await b.newContext();
await ctx2.addInitScript(()=>{ Object.defineProperty(window,'localStorage',{ get(){ throw new Error('blocked'); } }); });
const p2 = await ctx2.newPage();
const errs=[]; p2.on('pageerror',e=>errs.push(e.message));
await p2.goto(ONRAMP);
await p2.waitForTimeout(400);
t('renders with localStorage blocked', (await p2.locator('.stage').count())===5 && errs.length===0);
await p2.click('[data-log="e1"]'); await p2.waitForTimeout(200);
t('still usable with storage blocked', (await p2.textContent('#meterRead')).startsWith('1 of 57'));

await b.close();
console.log(ok.map(s=>'  PASS  '+s).join('\n'));
if(bad.length){ console.log('\n'+bad.map(s=>'  FAIL  '+s).join('\n')); process.exit(1); }
console.log(`\n${ok.length}/${ok.length} passed`);
