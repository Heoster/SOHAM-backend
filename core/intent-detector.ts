/**
 * SOHAM Intent Detection Brain
 * ─────────────────────────────
 * Intelligently classifies user intent so the Orchestrator can route to the
 * right tool, model, or pipeline.
 *
 * Intents:
 *   WEB_SEARCH       → real-time / factual queries
 *   IMAGE_GENERATION → "generate / draw / create an image of …"
 *   CODE_GENERATION  → "write a function / class / script …"
 *   EXPLANATION      → "explain / what is / how does …"
 *   CHAT             → general conversation (default)
 *
 * Used by:
 *   - Orchestrator (core/orchestrator.ts)
 *   - process-user-message flow (flows/process-user-message.ts)
 *   - actions.ts server actions
 */

export type IntentType =
  | 'WEB_SEARCH'
  | 'IMAGE_GENERATION'
  | 'CHAT'
  | 'CODE_GENERATION'
  | 'EXPLANATION'
  | 'TRANSLATION'
  | 'SENTIMENT_ANALYSIS'
  | 'GRAMMAR_CHECK'
  | 'QUIZ_GENERATION'
  | 'RECIPE'
  | 'JOKE'
  | 'DICTIONARY'
  | 'FACT_CHECK';

export interface IntentResult {
  intent: IntentType;
  confidence: number;
  extractedQuery: string;
  reasoning: string;
}

// ─── Real-time / factual web-search detector ─────────────────────────────────

export function requiresWebSearch(message: string): boolean {
  const lower = message.toLowerCase();

  const timeSensitive = [
    /\b(today|tonight|yesterday|this (week|month|year)|right now|currently|at the moment|as of|latest|recent|newest|breaking|live)\b/,
    /\b(news|headlines|update|announcement|release|launch|event|match|score|result|weather|forecast|stock|price|rate|trend)\b/,
    /\b(who (is|are|was|were) (the )?(current|new|latest|now))\b/,
    /\b(what (is|are) (the )?(current|latest|new|today'?s?))\b/,
    /\b(when (is|was|did|does|do))\b/,
    /\b(how much (does|is|are|did))\b/,
    /\b(is .+ (still|open|available|alive|working|running))\b/,
  ];

  const factualLookup = [
    /\b(who (invented|created|founded|discovered|wrote|made|built|designed))\b/,
    /\b(what (year|date|time|place|country|city) (was|is|did|does))\b/,
    /\b(where (is|are|was|were) .+ (located|based|from|born|founded))\b/,
    /\b(population of|capital of|currency of|president of|prime minister of|ceo of|founder of)\b/,
    /\b(definition of|meaning of|what does .+ mean)\b/,
  ];

  for (const pattern of [...timeSensitive, ...factualLookup]) {
    if (pattern.test(lower)) return true;
  }
  return false;
}

// ─── Intent Detector ─────────────────────────────────────────────────────────

export class IntentDetector {
  detect(message: string): IntentResult {
    const lower = message.toLowerCase().trim();

    const searchResult = this.detectWebSearch(lower, message);
    if (searchResult.confidence > 0.7) return searchResult;

    const imageResult = this.detectImageGeneration(lower, message);
    if (imageResult.confidence > 0.7) return imageResult;

    const codeResult = this.detectCodeGeneration(lower, message);
    if (codeResult.confidence > 0.6) return codeResult;

    const translateResult = this.detectTranslation(lower, message);
    if (translateResult.confidence > 0.7) return translateResult;

    const sentimentResult = this.detectSentiment(lower, message);
    if (sentimentResult.confidence > 0.7) return sentimentResult;

    const grammarResult = this.detectGrammar(lower, message);
    if (grammarResult.confidence > 0.7) return grammarResult;

    const quizResult = this.detectQuiz(lower, message);
    if (quizResult.confidence > 0.7) return quizResult;

    const recipeResult = this.detectRecipe(lower, message);
    if (recipeResult.confidence > 0.7) return recipeResult;

    const jokeResult = this.detectJoke(lower, message);
    if (jokeResult.confidence > 0.7) return jokeResult;

    const dictResult = this.detectDictionary(lower, message);
    if (dictResult.confidence > 0.7) return dictResult;

    const factCheckResult = this.detectFactCheck(lower, message);
    if (factCheckResult.confidence > 0.7) return factCheckResult;

    const explainResult = this.detectExplanation(lower, message);
    if (explainResult.confidence > 0.6) return explainResult;

    return { intent: 'CHAT', confidence: 1.0, extractedQuery: message, reasoning: 'General conversation' };
  }

  private detectWebSearch(_lower: string, original: string): IntentResult {
    if (requiresWebSearch(original)) {
      return { intent: 'WEB_SEARCH', confidence: 0.85, extractedQuery: original, reasoning: 'Query requires real-time or factual web data' };
    }

    const patterns = [
      { regex: /^(search|google|bing|find|lookup|look up)\s+(for|about|on)?\s*(.+)/i, weight: 1.0 },
      { regex: /^web\s+search\s+(.+)/i, weight: 1.0 },
      { regex: /^(what|who|where|when|why|how)\s+(is|are|was|were|did|does|do)\s+(.+)/i, weight: 0.8 },
      { regex: /^(tell me|show me|find me)\s+(about|information on|info about|details on)\s+(.+)/i, weight: 0.9 },
      { regex: /(latest|current|recent|newest|today'?s?|this week'?s?)\s+(news|updates?|information|data|stats?|trends?)/i, weight: 0.95 },
      { regex: /what'?s?\s+(new|happening|trending|going on)\s+(with|in|about|on)/i, weight: 0.9 },
      { regex: /(news|article|blog|post|report|study|research|paper)\s+(about|on|regarding)/i, weight: 0.85 },
      { regex: /(price|cost|review|comparison|vs|versus)\s+of/i, weight: 0.8 },
      { regex: /^(can you|could you|please)\s+(search|find|look up|get|fetch)/i, weight: 0.9 },
      { regex: /^(i need|i want|i'm looking for)\s+(information|details|data|facts)\s+(about|on)/i, weight: 0.85 },
      { regex: /(today|yesterday|this week|this month|this year|now|currently)/i, weight: 0.7 },
      { regex: /(breaking|live|real-time|up-to-date)/i, weight: 0.85 },
    ];

    let maxConfidence = 0;
    let extractedQuery = original;
    let matchedPattern = '';

    for (const p of patterns) {
      const match = original.match(p.regex);
      if (match && p.weight > maxConfidence) {
        maxConfidence = p.weight;
        matchedPattern = p.regex.source;
        extractedQuery = match[3] || match[1] || original.replace(/^(search|google|find|lookup|look up|web search|tell me|show me)\s+(for|about|on)?\s*/i, '').trim();
      }
    }

    return { intent: 'WEB_SEARCH', confidence: maxConfidence, extractedQuery, reasoning: maxConfidence > 0 ? `Matched: ${matchedPattern}` : 'No search pattern matched' };
  }

  private detectImageGeneration(_lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /^(generate|create|make|draw|paint|design|produce)\s+(an?|the)?\s*(image|picture|photo|illustration|artwork|graphic)\s+(of|showing|depicting|with)?\s*(.+)/i, weight: 1.0 },
      { regex: /^(image|picture|photo|illustration)\s+(of|showing|depicting)\s+(.+)/i, weight: 0.95 },
      { regex: /(photo-?realistic|artistic|anime|sketch|cartoon|3d|abstract|minimalist|vintage|watercolor|oil painting|digital art)\s+(image|picture|photo|art|painting|drawing|illustration)?\s*(of|showing|depicting)?/i, weight: 0.95 },
      { regex: /^(visualize|show me|i want to see|can you show)\s+(an?|the)?\s*(image|picture|visualization|photo|illustration)\s+(of|showing)?/i, weight: 0.9 },
      { regex: /^show me\s+(an?\s+)?(image|picture|photo|illustration|drawing|painting|sketch)\s+(of\s+)?(.+)/i, weight: 0.95 },
      { regex: /^(draw|paint|sketch|illustrate|render)\s+me\s+(.+)/i, weight: 0.95 },
      { regex: /^(draw|paint|sketch|illustrate|render)\s+(.+)/i, weight: 0.85 },
      { regex: /^i\s+(want|need|would like)\s+(an?|the)?\s*(image|picture|photo|illustration|drawing|painting|sketch)\s+(of|showing|depicting)?\s*(.+)/i, weight: 0.95 },
      { regex: /^(can you|could you|please)\s+(generate|create|make|draw|paint|design|produce)\s+(an?|the)?\s*(image|picture|photo|illustration|artwork|graphic)?\s*(of|showing|depicting|with)?\s*(.+)/i, weight: 0.95 },
      { regex: /^(a|an)\s+.*(landscape|portrait|scene|sunset|sunrise|mountain|ocean|city|forest|space|galaxy|painting|artwork|illustration|drawing|sketch)\s*(of|showing|depicting|with)?/i, weight: 0.8 },
    ];

    let maxConfidence = 0;
    let extractedQuery = original;
    let matchedPattern = '';

    for (const p of patterns) {
      const match = original.match(p.regex);
      if (match && p.weight > maxConfidence) {
        maxConfidence = p.weight;
        matchedPattern = p.regex.source;
        const groups = match.slice(1).filter(Boolean);
        const subject = groups.reverse().find(g => g.length > 3 && !/^(an?|the|of|showing|depicting|with|me|please)$/i.test(g.trim()));
        extractedQuery = subject
          ? subject.trim()
          : original.replace(/^(can you|could you|please)\s+/i, '').replace(/^(generate|create|make|draw|paint|design|produce|illustrate|render|sketch|visualize|show me|i want to see|i want|i need|i would like)\s+/i, '').replace(/^(an?|the)\s+/i, '').replace(/^(image|picture|photo|illustration|artwork|graphic|drawing|painting|sketch)\s+(of|showing|depicting)?\s*/i, '').trim();
      }
    }

    return { intent: 'IMAGE_GENERATION', confidence: maxConfidence, extractedQuery, reasoning: maxConfidence > 0 ? `Matched: ${matchedPattern}` : 'No image pattern matched' };
  }

  private detectCodeGeneration(_lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /^(write|create|generate|make|build)\s+(a|an|the)?\s*(function|class|component|script|program|code|api|endpoint)/i, weight: 0.9 },
      { regex: /^(code|implement|develop)\s+(a|an|the)?\s*(.+)/i, weight: 0.8 },
      { regex: /(python|javascript|typescript|react|node|java|c\+\+|rust|go)\s+(code|function|class|script)/i, weight: 0.85 },
    ];

    let maxConfidence = 0;
    for (const p of patterns) {
      if (p.regex.test(original)) maxConfidence = Math.max(maxConfidence, p.weight);
    }

    return { intent: 'CODE_GENERATION', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected code generation request' : 'No code pattern matched' };
  }

  private detectExplanation(_lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /^(explain|describe|what is|what are|define|clarify)\s+(.+)/i, weight: 0.8 },
      { regex: /^(how does|how do|why does|why do)\s+(.+)\s+(work|function|operate)/i, weight: 0.85 },
      { regex: /^(tell me about|teach me|help me understand)\s+(.+)/i, weight: 0.8 },
    ];

    let maxConfidence = 0;
    for (const p of patterns) {
      if (p.regex.test(original)) maxConfidence = Math.max(maxConfidence, p.weight);
    }

    return { intent: 'EXPLANATION', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected explanation request' : 'No explanation pattern matched' };
  }

  private detectTranslation(_lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /^(translate|translation of)\s+(.+)\s+(to|into)\s+([a-zA-Z]+)/i, weight: 1.0 },
      { regex: /^(translate|say|how (do you|do i) say)\s+(.+)\s+in\s+([a-zA-Z]+)/i, weight: 0.95 },
      { regex: /\b(translate|translation)\b/i, weight: 0.8 },
      { regex: /\bin\s+(spanish|french|hindi|german|japanese|chinese|arabic|portuguese|russian|korean|italian|turkish|dutch|polish|swedish|norwegian|danish|finnish|greek|hebrew|thai|vietnamese|indonesian|malay|bengali|urdu|tamil|telugu|marathi|gujarati|punjabi|kannada|malayalam)\b/i, weight: 0.85 },
    ];
    let maxConfidence = 0;
    for (const p of patterns) {
      if (p.regex.test(original)) maxConfidence = Math.max(maxConfidence, p.weight);
    }
    return { intent: 'TRANSLATION', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected translation request' : 'No translation pattern matched' };
  }

  private detectSentiment(_lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(sentiment|emotion|tone|feeling|mood)\s+(of|in|for|analysis)\b/i, weight: 0.9 },
      { regex: /\b(analyze|analyse)\s+(the\s+)?(sentiment|emotion|tone|feeling|mood)\b/i, weight: 0.95 },
      { regex: /\b(is (this|the|my) (text|message|review|comment|post) (positive|negative|neutral))\b/i, weight: 0.9 },
      { regex: /\b(what('?s| is) the (sentiment|tone|emotion|feeling) (of|in))\b/i, weight: 0.9 },
    ];
    let maxConfidence = 0;
    for (const p of patterns) {
      if (p.regex.test(original)) maxConfidence = Math.max(maxConfidence, p.weight);
    }
    return { intent: 'SENTIMENT_ANALYSIS', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected sentiment analysis request' : 'No sentiment pattern matched' };
  }

  private detectGrammar(_lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(grammar|proofread|proofreading|spell.?check)\b/i, weight: 0.9 },
      { regex: /\b(correct|fix|improve)\s+(my|this|the)\s+(grammar|spelling|writing|text|essay|email|sentence)\b/i, weight: 0.95 },
      { regex: /\b(check (my|this|the) (grammar|spelling|writing))\b/i, weight: 0.9 },
      { regex: /\b(rewrite|rephrase|paraphrase)\s+(this|my|the)\b/i, weight: 0.8 },
    ];
    let maxConfidence = 0;
    for (const p of patterns) {
      if (p.regex.test(original)) maxConfidence = Math.max(maxConfidence, p.weight);
    }
    return { intent: 'GRAMMAR_CHECK', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected grammar check request' : 'No grammar pattern matched' };
  }

  private detectQuiz(_lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(quiz|flashcard|flashcards)\b/i, weight: 0.9 },
      { regex: /\b(make|create|generate)\s+(a\s+)?(quiz|test|flashcard|study guide|questions)\b/i, weight: 0.95 },
      { regex: /\b(test me|quiz me)\s+(on|about)\b/i, weight: 0.95 },
      { regex: /\b(study (material|guide|questions|cards))\b/i, weight: 0.85 },
    ];
    let maxConfidence = 0;
    for (const p of patterns) {
      if (p.regex.test(original)) maxConfidence = Math.max(maxConfidence, p.weight);
    }
    return { intent: 'QUIZ_GENERATION', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected quiz generation request' : 'No quiz pattern matched' };
  }

  private detectRecipe(_lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(recipe|recipes)\b/i, weight: 0.9 },
      { regex: /\b(how (to|do i) (cook|make|bake|prepare|grill|fry|boil))\b/i, weight: 0.9 },
      { regex: /\b(what (can|should) i (cook|make|eat|prepare))\b/i, weight: 0.85 },
      { regex: /\b(ingredients (for|to make))\b/i, weight: 0.9 },
      { regex: /\b(dish|meal|food idea|dinner idea|lunch idea|breakfast idea)\b/i, weight: 0.75 },
    ];
    let maxConfidence = 0;
    for (const p of patterns) {
      if (p.regex.test(original)) maxConfidence = Math.max(maxConfidence, p.weight);
    }
    return { intent: 'RECIPE', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected recipe request' : 'No recipe pattern matched' };
  }

  private detectJoke(_lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(tell (me )?(a )?(joke|pun|riddle|fun fact))\b/i, weight: 0.95 },
      { regex: /\b(make me (laugh|smile))\b/i, weight: 0.9 },
      { regex: /\b(roast me|roast (my|this))\b/i, weight: 0.95 },
      { regex: /\b(give me a (joke|pun|riddle|compliment|pickup line|fun fact))\b/i, weight: 0.95 },
      { regex: /\b(something funny|be funny|be witty)\b/i, weight: 0.8 },
    ];
    let maxConfidence = 0;
    for (const p of patterns) {
      if (p.regex.test(original)) maxConfidence = Math.max(maxConfidence, p.weight);
    }
    return { intent: 'JOKE', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected joke/fun request' : 'No joke pattern matched' };
  }

  private detectDictionary(_lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /^(define|definition of|what does .+ mean|meaning of)\b/i, weight: 0.95 },
      { regex: /\b(synonym(s)? (of|for)|antonym(s)? (of|for))\b/i, weight: 0.9 },
      { regex: /\b(etymology of|word origin of|history of the word)\b/i, weight: 0.9 },
      { regex: /\b(what is the meaning of|what does .+ mean)\b/i, weight: 0.9 },
      { regex: /\b(look up the word|dictionary (entry|definition) (for|of))\b/i, weight: 0.95 },
    ];
    let maxConfidence = 0;
    for (const p of patterns) {
      if (p.regex.test(original)) maxConfidence = Math.max(maxConfidence, p.weight);
    }
    return { intent: 'DICTIONARY', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected dictionary lookup request' : 'No dictionary pattern matched' };
  }

  private detectFactCheck(_lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(fact.?check|fact checking)\b/i, weight: 0.95 },
      { regex: /\b(is it true (that)?|is (this|that) true)\b/i, weight: 0.9 },
      { regex: /\b(verify (that|this|the claim|the fact))\b/i, weight: 0.9 },
      { regex: /\b(debunk|myth or fact|true or false|is .+ a myth)\b/i, weight: 0.9 },
      { regex: /\b(did .+ really|is it a fact that)\b/i, weight: 0.85 },
    ];
    let maxConfidence = 0;
    for (const p of patterns) {
      if (p.regex.test(original)) maxConfidence = Math.max(maxConfidence, p.weight);
    }
    return { intent: 'FACT_CHECK', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected fact-check request' : 'No fact-check pattern matched' };
  }
}

// Singleton
let _instance: IntentDetector | null = null;
export function getIntentDetector(): IntentDetector {
  if (!_instance) _instance = new IntentDetector();
  return _instance;
}
