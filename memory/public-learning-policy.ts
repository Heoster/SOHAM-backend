/** Automatic cross-user publishing is opt-in, separate from private user memory. */
export function publicAutoLearningEnabled(): boolean {
  return process.env.SOHAM_PUBLIC_AUTO_LEARN_ENABLED === '1';
}

export const PRIVATE_CONTEXT_RE = /USER_MEMORY|USER_PROFILE|SOHAM_MEMORY|SOHAM_CONTEXT|\b(?:pref|preference)\s*:/i;
const TRANSIENT = /\b(today|tonight|tomorrow|yesterday|latest|current|live|headlines?|news|weather|forecast|stock price|score|scores|right now|this week)\b/i;
const FAILURE = /\b(couldn['’]?t|cannot|can['’]?t|unable to|unavailable|lookup failed|search failed|no (?:relevant |recent |matching )?(?:results|data)|try again|check (?:these|the following) (?:sites|websites))\b/i;

export function safePublicLearningText(...texts: string[]): boolean {
  return publicAutoLearningEnabled() && texts.every(text => !PRIVATE_CONTEXT_RE.test(text) && !/\b(my|mine|our|password|api key|access token)\b/i.test(text));
}

export function shouldLearnPublicQA(question: string, answer: string, hasToolResults = false): boolean {
  return safePublicLearningText(question, answer) && !hasToolResults &&
    !TRANSIENT.test(question) && !FAILURE.test(answer) &&
    /\b(what|who|when|where|why|how|define|explain|is|are|was|were|does|did|can|will)\b/i.test(question) &&
    answer.trim().length > 100 && !/^(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|bye|goodbye)\b/i.test(answer.trim());
}

/** Suppress previously contaminated/generated public entries without deleting data. */
export function hideUnsafePublicEntry(entry: { question?: string; content: string; source?: string; tags?: string[] }): boolean {
  if (PRIVATE_CONTEXT_RE.test(`${entry.question || ''}\n${entry.content}`)) return true;
  const generated = entry.source?.startsWith('soham-') || ['user-correction', 'user-suggestion'].includes(entry.source || '') || entry.tags?.includes('auto-learned');
  return Boolean(generated && (!publicAutoLearningEnabled() || TRANSIENT.test(entry.question || '') || FAILURE.test(entry.content)));
}
