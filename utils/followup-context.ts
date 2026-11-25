import type { ConversationTurnLike } from '../tools/youtube-play';

/** Preserve a small, untrusted subject hint from a client-side widget, not its whole payload. */
export function historyContent(message: any): string {
  const content = typeof message?.content === 'string' ? message.content : '';
  const widget = message?.video;
  const selected = widget?.video || widget;
  const title = typeof selected?.title === 'string' && !/^YouTube video /i.test(selected.title) ? selected.title : '';
  const query = typeof widget?.query === 'string' ? widget.query : '';
  return content + (title || query ? `\n[Unverified video subject: ${[query, title].filter(Boolean).join(' — ').slice(0, 350)}]` : '');
}

const reference = /\b(this|that|same|above|previous)\s+(match|game|video|forecast)|\b(it|there)\b/i;

/** Resolve only explicit follow-ups, prioritising user subjects over potentially wrong AI replies. */
export function resolveDataFollowup(query: string, history: ConversationTurnLike[]): string {
  if (!reference.test(query) || /\b(play|watch|versus|vs)\b/i.test(query)) return query;
  for (const turn of history.slice(-10).reverse()) {
    if (turn.role !== 'user') continue;
    const text = String(turn.content).slice(0, 700);
    if (reference.test(text)) continue;
    if (/\b(?:vs\.?|versus)\b/i.test(text) && /\b(match|game|video|info|score|details|it)\b/i.test(query)) {
      const subject = text.replace(/^(?:please\s+)?(?:play|watch|search|show)\s+/i, '').replace(/\b(highlights?|video)\b/gi, '').trim();
      return `${subject} ${/score|live/i.test(query) ? 'score' : 'match details'}${query.match(/\b20\d{2}\b/g)?.map(year => ` ${year}`).join('') || ''}`;
    }
    if (/\b(weather|forecast|temperature)\b/i.test(text) && /\b(weather|forecast|rain|tomorrow|there|it)\b/i.test(query)) {
      return `${text.replace(/\b(today|now|tomorrow)\b/gi, '')} ${query.replace(/\b(it|there|this forecast|that forecast)\b/gi, '').trim()}`;
    }
  }
  // Widget-only clients may omit the initiating user message. Use only the
  // explicitly labelled subject, never arbitrary prior assistant commentary.
  if (/\b(match|game|video)\b/i.test(query)) {
    for (const turn of history.slice(-6).reverse()) {
      const hint = String(turn.content).match(/\[Unverified video subject: ([^\]\n]+)\]/)?.[1];
      if (hint && /\b(?:vs|versus)\b/i.test(hint)) return `${hint.slice(0, 300)} match details`;
    }
  }
  return query;
}
