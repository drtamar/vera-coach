/**
 * Reading the page aloud.
 *
 * Uses the browser's own speech synthesis — no API, no key, no network, and it
 * works when model access is declined. Every block of explanation gets a button
 * rather than an autoplay: audio that starts by itself is hostile, and someone
 * practising being on camera does not need a second voice arriving unasked.
 */

export const isAvailable = () => typeof speechSynthesis !== 'undefined';

/**
 * Voices load asynchronously and the first call usually returns an empty list.
 * Resolve on `voiceschanged`, with a timeout so a browser that never fires it
 * does not hang the caller forever.
 */
export function voices({ timeoutMs = 1500 } = {}) {
  if (!isAvailable()) return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(speechSynthesis.getVoices()); };
    speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
    setTimeout(finish, timeoutMs);
  });
}

/** Prefer a natural-sounding local voice in the page's language. */
export function pickVoice(list, { lang = 'en', prefer = [] } = {}) {
  if (!list?.length) return null;
  const inLang = list.filter(v => (v.lang || '').toLowerCase().startsWith(lang.toLowerCase()));
  const pool = inLang.length ? inLang : list;
  for (const name of prefer) {
    const hit = pool.find(v => (v.name || '').toLowerCase().includes(name.toLowerCase()));
    if (hit) return hit;
  }
  return pool.find(v => v.localService) || pool[0];
}

/**
 * Split on sentence boundaries.
 *
 * Several engines truncate a long utterance silently — it simply stops
 * mid-sentence with no error — so long text is spoken as a queue of shorter
 * ones. Splitting also makes stopping responsive.
 */
export function chunk(text, max = 220) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [clean];
  const out = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + s).length > max && buf) { out.push(buf.trim()); buf = s; }
    else buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

let current = null;

/** Is anything being spoken right now? */
export const speaking = () => current !== null;

/** Stop immediately and drop anything queued. */
export function stop() {
  current = null;
  if (isAvailable()) { try { speechSynthesis.cancel(); } catch {} }
}

/**
 * Speak `text`. Resolves when finished, or immediately if unavailable.
 * Starting a new utterance cancels whatever was playing — one voice at a time.
 */
export function speak(text, { voice = null, rate = 1, pitch = 1, onDone = null, onChunk = null } = {}) {
  if (!isAvailable()) return Promise.resolve(false);
  stop();
  const parts = chunk(text);
  if (!parts.length) return Promise.resolve(false);

  const token = {};
  current = token;

  return new Promise(resolve => {
    let i = 0;
    const next = () => {
      if (current !== token) return resolve(false);        // superseded or stopped
      if (i >= parts.length) { current = null; onDone?.(); return resolve(true); }
      const u = new SpeechSynthesisUtterance(parts[i]);
      if (voice) u.voice = voice;
      u.rate = rate; u.pitch = pitch;
      onChunk?.(i, parts.length);
      u.onend = () => { i++; next(); };
      // An engine that errors mid-queue must not strand the promise.
      u.onerror = () => { current = null; onDone?.(); resolve(false); };
      try { speechSynthesis.speak(u); } catch { current = null; resolve(false); }
    };
    next();
  });
}
