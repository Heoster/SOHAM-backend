/**
 * Strip frontend-injected system context from the raw user message.
 *
 * The chat frontend appends a SOHAM_CLOCK block to the user's message so the
 * model can answer time/date questions, e.g.:
 *
 *   Play Big Buck Bunny
 *
 *   SOHAM_CLOCK
 *   Timezone: India Standard Time (IST, UTC+05:30) … UTC now: 2026-11-18 13:09:46
 *   Answer every question about the current time, date or day from this clock. Never guess it.
 *
 * That block is for the model's eyes only. If it reaches intent detection,
 * tool routing, or the search pipeline, queries get polluted with clock text
 * ("News … Today Wednesday …") and multi-line regexes silently fail.
 *
 * Always run this before analysis/routing/tools — but pass the ORIGINAL
 * message to the model prompt, which legitimately needs the clock.
 */
export function stripInjectedContext(message: string): string {
  let m = (message ?? '').replace(/\r\n?/g, '\n');

  const clockIdx = m.search(/SOHAM_CLOCK/i);
  if (clockIdx !== -1) {
    // Walk back over the whitespace/newlines separating user text from the block
    let start = clockIdx;
    while (start > 0 && (m[start - 1] === '\n' || m[start - 1] === ' ' || m[start - 1] === '\t')) start--;

    // The injected block ends with the documented tail marker "Never guess it[.]"
    let end = m.length;
    const tailMark = m.indexOf('Never guess it', clockIdx);
    if (tailMark !== -1) {
      end = tailMark + 'Never guess it'.length;
      if (m[end] === '.') end += 1;
      while (end < m.length && (m[end] === '\n' || m[end] === ' ' || m[end] === '\t')) end += 1;
    }

    m = m.slice(0, start) + m.slice(end);
  }

  return m
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, ' ') // control chars, keeping \n
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
