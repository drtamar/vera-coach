/**
 * Hand a prompt to Grok on the viewer's own subscription.
 *
 * A published page cannot sign in as them, and this product does not call the
 * xAI API. The subscription route is a link they open. grok.com reads `?q=`
 * and submits it in their own session. This module builds that URL. It does
 * not call the network.
 */

export const GROK_ORIGIN = 'https://grok.com/';

/** Raw characters. A normal review fits. A long transcript is cut from the tail. */
export const GROK_QUERY_MAX = 4000;

const CUT_NOTE = '\n\n[Cut to fit a subscription link. No API was called. Honesty rules above still hold.]';

/**
 * Keep the head of the prompt (persona, then the honesty floor) and drop the
 * tail (usually the transcript) when the link would be too long.
 */
export function packPrompt(prompt, max = GROK_QUERY_MAX) {
  const text = String(prompt ?? '').trim();
  if (text.length <= max) return { text, trimmed: false };
  const room = Math.max(0, max - CUT_NOTE.length);
  return { text: text.slice(0, room).trimEnd() + CUT_NOTE, trimmed: true };
}

/** `{ url, text, trimmed }`. Empty prompt is the bare origin, no query. */
export function grokChatUrl(prompt) {
  const packed = packPrompt(prompt);
  if (!packed.text) return { url: GROK_ORIGIN, text: '', trimmed: false };
  return { url: `https://grok.com/?q=${encodeURIComponent(packed.text)}`, ...packed };
}
