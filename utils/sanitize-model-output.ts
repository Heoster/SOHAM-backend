/**
 * Sanitize raw model output for user-visible display.
 *
 * Weaker free-tier models (e.g. openrouter/openrouter/free → random backends)
 * sometimes emit their internal tool-call / reasoning syntax as plain text:
 *
 *   <dots_function_call>
 *   <think>
 *   <invoke name="web_search">
 *   < latest phones under ₹22000 India 2026
 *   </parameter>
 *   <parameter name="count">10</parameter>
 *   </invoke>
 *   </dots_function_call>
 *   <
 *
 * That markup must never reach the client or the persisted memory. This module
 * provides:
 *
 *   sanitizeModelOutput(text)  — one-shot cleanup of a complete string
 *   TokenOutputSanitizer       — incremental filter for streamed token chunks
 *
 * Only known tool/reasoning tag names are removed, so benign markup the user
 * asked about (<div>, <table>…) survives untouched.
 */

// Tool-call / reasoning tag vocabulary seen from OpenRouter free models,
// DeepSeek-style think blocks, and Anthropic-style invoke markup.
const BLOCK_TAGS = [
  'dots_function_call',
  'function_calls',
  'function_call',
  'function_results',
  'tool_calls',
  'tool_call',
  'tool_use',
  'tool_result',
  'tool_response',
  'invoke',
  'parameter',
  'think',
  'thinking',
  'reasoning',
  'antthinking',
  'scratchpad',
  'reflection',
];

const TAG_RE_SOURCE = BLOCK_TAGS.join('|');

// Anything that opens one of those tags: `<tag`, `<tag attr="…">` or a closing
// `</tag>`. Attribute values may contain `>` inside quotes, so match attrs as
// "not a double-quote, or a quoted string".
const ANY_TAG_RE = new RegExp(
  `</?(?:${TAG_RE_SOURCE})(?:\\s(?:"[^"]*"|'[^']*'|[^>"'])*)?\\s*/?>`,
  'gi',
);
const PAIRED_BLOCK_RE = new RegExp(
  `<(${TAG_RE_SOURCE})(?:\\s(?:"[^"]*"|'[^']*'|[^>"'])*)?>[\\s\\S]*?</\\1\\s*>`,
  'gi',
);
const UNTERMINATED_BLOCK_RE = new RegExp(
  `<(${TAG_RE_SOURCE})(?:\\s(?:"[^"]*"|'[^']*'|[^>"'])*)?>[\\s\\S]*$`,
  'gi',
);
const OPEN_TAG_RE = new RegExp(
  `<(${TAG_RE_SOURCE})(?:\\s(?:"[^"]*"|'[^']*'|[^>"'])*)?>`,
  'gi',
);

// JSON object with an "action" key naming a tool — the ReAct-style payload
// weak free models print instead of answering (see utils/action-json.ts).
// Allows one level of nesting ("args": {…}); anything deeper is left alone, as
// is any object without an "action" key. The whole-output rescue case is
// handled by parseActionJson() in the routes.
const ACTION_JSON_RE = /\{(?:[^{}]|\{[^{}]*\})*"action"(?:[^{}]|\{[^{}]*\})*\}/gi;


/** True when every '{' in the fragment has a matching '}'. */
function balancedBraces(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** One-shot cleanup of a complete model response. */
export function sanitizeModelOutput(raw: string): string {
  if (!raw) return raw;
  let text = raw;

  // Paired blocks first (innermost out) — loop to unwrap nesting like
  // <dots_function_call><think>…</think></dots_function_call>.
  for (let i = 0; i < 4; i += 1) {
    const next = text.replace(PAIRED_BLOCK_RE, '');
    if (next === text) break;
    text = next;
  }
  // An opening tag with no matching close eats the remainder of the message —
  // that is what the model meant (its "answer" was the tool-call payload).
  text = text.replace(UNTERMINATED_BLOCK_RE, '');
  // Stray open/close tags without a pair.
  text = text.replace(ANY_TAG_RE, '');
  // Raw action-JSON payloads the model printed instead of answering.
  text = text.replace(ACTION_JSON_RE, '');
  // Trailing unterminated action-JSON (stream cut off inside the payload).
  text = text.replace(/\{(?:[^{}]|\{[^{}]*\})*"action"[\s\S]*$/i, m =>
    balancedBraces(m) ? m : '');
  // Empty code fences left behind by removed payloads (```json \n\n ```)
  text = text.replace(/```[a-z0-9]*[ \t]*(?:\n\s*)*```/gi, '');
  // Orphaned opener fragments split by other removals (e.g. "<" left behind).
  text = text.replace(/<[A-Za-z_][\w-]*\s*$/g, '').replace(/<\s*$/g, '');
  // A lone "<" line from the observed failure mode.
  text = text.replace(/<(\s*\n)*\s*$/g, '');

  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Incremental token filter. Feed every chunk from the model; emit only text
 * that cannot still become tool/reasoning markup. Everything dropped here is
 * by design — the frontend live-renders what we emit and cannot retract it,
 * so we must err on the side of withholding.
 */
export class TokenOutputSanitizer {
  private pending = '';
  /** Tag name we are currently inside (dropping until its close tag), if any. */
  private dropUntil: string | null = null;

  /** Feed a chunk; returns the text that is safe to show now (may be ''). */
  push(chunk: string): string {
    this.pending += chunk;
    let out = '';

    for (;;) {
      // ── Inside a dropped block: wait for its close tag ───────────────────
      if (this.dropUntil) {
        const close = `</${this.dropUntil}`;
        const idx = this.indexOfCI(this.pending, close);
        if (idx === -1) {
          // Keep only the longest tail that could still be the start of "</tag".
          const keep = close.length + 2;
          if (this.pending.length > keep) this.pending = this.pending.slice(-keep);
          return out;
        }
        const end = this.pending.indexOf('>', idx + close.length);
        if (end === -1) {
          // Close tag split across chunk boundary — keep it, wait for '>'.
          this.pending = this.pending.slice(idx);
          return out;
        }
        this.pending = this.pending.slice(end + 1);
        this.dropUntil = null;
        continue;
      }

      // ── Drop a complete action-JSON object if one is pending ─────────────
      const actionIdx = this.findNextActionJson(this.pending);
      if (actionIdx) {
        out += this.pending.slice(0, actionIdx.index);
        this.pending = this.pending.slice(actionIdx.end);
        continue;
      }

      // ── Find the next tool/reasoning tag in the pending buffer ───────────
      const tag = this.findNextTag(this.pending);
      if (tag) {
        out += this.pending.slice(0, tag.index);
        if (tag.closing) {
          // Stray close tag — drop just the tag.
          this.pending = this.pending.slice(tag.end);
          continue;
        }
        // Opening tag — drop everything until the matching close tag.
        this.dropUntil = tag.name;
        this.pending = this.pending.slice(tag.end);
        continue;
      }

      // ── No tag (yet). Hold back anything that could still become one ────
      const hold = this.holdbackLength(this.pending);
      out += this.pending.slice(0, this.pending.length - hold);
      this.pending = hold > 0 ? this.pending.slice(-hold) : '';
      return out;
    }
  }

  /** End of stream: emit whatever is safe and drop unterminated markup. */
  flush(): string {
    if (this.dropUntil) {
      // Stream ended inside a tool/think block — it was never a user-visible reply.
      this.pending = '';
      this.dropUntil = null;
      return '';
    }
    const pending = this.pending;
    this.pending = '';
    return sanitizeModelOutput(pending);
  }

  private indexOfCI(haystack: string, needle: string): number {
    return haystack.toLowerCase().indexOf(needle.toLowerCase());
  }

  private findNextActionJson(text: string): { index: number; end: number } | null {
    const re = new RegExp(ACTION_JSON_RE.source, 'gi');
    const match = re.exec(text);
    if (!match) return null;
    return { index: match.index, end: match.index + match[0].length };
  }

  private findNextTag(text: string): { index: number; end: number; name: string; closing: boolean } | null {
    const re = new RegExp(ANY_TAG_RE.source, 'gi');
    const match = re.exec(text);
    if (!match) return null;
    const body = match[0];
    const nameMatch = body.match(/<\s*(\/?)\s*([A-Za-z_][A-Za-z0-9_-]*)/);
    if (!nameMatch) return null;
    return {
      index: match.index,
      end: match.index + body.length,
      name: nameMatch[2].toLowerCase(),
      closing: nameMatch[1] === '/',
    };
  }

  private holdbackLength(text: string): number {
    // ── Partial action-JSON first: the outermost unterminated '{' that could
    // still grow into an action descriptor. Checked before tag holdback so an
    // earlier "<…>" in the text can't mask it.
    const actionStart = this.actionJsonHoldStart(text);
    if (actionStart !== -1) return text.length - actionStart;

    const lt = text.lastIndexOf('<');
    if (lt === -1) return 0;
    const tail = text.slice(lt);
    // A ">" already in the tail means it was either matched as a tag above or
    // is plain literal text like "a <b> c" with an unknown tag — safe to emit.
    if (tail.includes('>')) return 0;
    // Bound the holdback so pathological input can't swallow the stream.
    if (tail.length > 400) return 0;
    // Bare "<" or "</" — could become anything.
    if (/^<\/?\s*$/.test(tail)) return tail.length;
    // Partial/known tool tag name (or a prefix of one) not yet closed by '>':
    // hold it — it may still grow into markup we must drop.
    const m = tail.match(/^<\/?([A-Za-z_][A-Za-z0-9_-]*)/);
    if (m) {
      const name = m[1].toLowerCase();
      return BLOCK_TAGS.some(tag => tag === name || tag.startsWith(name)) ? tail.length : 0;
    }
    // "<" + space (e.g. "< latest phones…") from the observed failure mode.
    if (/^<\s+[^\n]{0,120}$/.test(tail)) return tail.length;
    return 0;
  }

  /**
   * Index of the outermost unterminated '{' that plausibly starts an
   * action-JSON object, or -1. Holds from there so streaming JSON can't leak
   * partial objects before the closing '}' arrives.
   */
  private actionJsonHoldStart(text: string): number {
    if (!text.includes('{')) return -1;
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '{') {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth <= 0) { depth = 0; start = -1; }
      }
    }
    if (depth === 0 || start === -1) return -1;
    const tail = text.slice(start);
    if (tail.length > 600) return -1;
    // Hold anything short starting with '{' (might still become an action
    // object) — once it outgrows that, require an "action" key to be present.
    if (/^\{[\s\S]{0,40}$/.test(tail)) return start;
    if (tail.includes('"action"')) return start;
    return -1;
  }
}
