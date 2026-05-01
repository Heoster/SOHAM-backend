/**
 * SOHAM Intent Detection Brain
 * ─────────────────────────────
 * Production detector for routing chat requests to tools, image generation,
 * and task-specific pipelines.
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

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'model';
  content: string;
}

export interface IntentResult {
  intent: IntentType;
  confidence: number;
  extractedQuery: string;
  reasoning: string;
}

interface ScoredIntent extends IntentResult {}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * SMART Normalization
 * Expands short forms (CM, PM, DM) and handles Hinglish commonalities
 */
function smartNormalize(text: string): string {
  let low = text.toLowerCase().trim();
  
  // Title Expansions
  const expansions: Record<string, string> = {
    'pm': 'prime minister',
    'cm': 'chief minister',
    'dm': 'district magistrate',
    'hm': 'home minister',
    'fm': 'finance minister',
    'mla': 'member of legislative assembly',
    'mp': 'member of parliament',
    'vpm': 'vice president',
    'prez': 'president',
  };

  // Replace whole words only
  Object.entries(expansions).forEach(([short, full]) => {
    const reg = new RegExp(`\\b${short}\\b`, 'gi');
    low = low.replace(reg, full);
  });

  return low.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildContextualMessage(message: string, history: ConversationTurn[] = []): string {
  const trimmed = message.trim();
  const shortFollowUp = trimmed.split(/\s+/).length <= 6;
  const needsContext =
    /\b(this|that|it|same|again|more|continue|also|why|how about|what about|role|details|kya|kyu|kaise|kaha|kab)\b/i.test(trimmed) ||
    shortFollowUp;

  if (!needsContext) {
    return trimmed;
  }

  const lastUserTurn = [...history]
    .reverse()
    .find(turn => (turn.role === 'user' || turn.role === 'assistant' || turn.role === 'model') && turn.content.trim().length > 0);

  if (!lastUserTurn) {
    return trimmed;
  }

  return `${lastUserTurn.content.trim()} ${trimmed}`.trim();
}

function hasExplicitExplanationSignal(message: string): boolean {
  return /^(explain|describe|clarify|teach me|help me understand|tell me about|samjhao|batao|kya hai|kya hota hai)\b/i.test(message.trim());
}

function isFollowUpExplanation(message: string): boolean {
  return /^(what about|how about|tell me more about|more about|what else about|kya|kyu|aur batao)\b/i.test(message.trim());
}

function hasExplicitNonSearchSignal(message: string): boolean {
  return (
    hasExplicitExplanationSignal(message) ||
    /\b(grammar|proofread|proofreading|spell.?check|rewrite|rephrase|paraphrase|galti|sudharo)\b/i.test(message) ||
    /\b(sentiment|emotion|tone|mood|feeling)\b/i.test(message) ||
    /\b(quiz|flashcard|recipe|joke|riddle|define|definition|meaning of|fact.?check|khana|pakwan|majak|kahani|matlab|arth)\b/i.test(message) ||
    /^(write|build|create|generate|make|implement|develop|likho|banao)\b.+\b(function|class|component|script|program|code|api|endpoint|program)\b/i.test(message)
  );
}

export function requiresWebSearch(message: string): boolean {
  const lower = smartNormalize(message);

  if (hasExplicitNonSearchSignal(message)) {
    return false;
  }

  const explicitSolveSignals = [
    /\b(solve|calculate|simplify|evaluate|integrate|differentiate|factorize|derive|prove|hal karo)\b/,
    /\b(equation|expression|formula|matrix|determinant|polynomial|integral|derivative|sutra)\b/,
  ];

  if (explicitSolveSignals.some(pattern => pattern.test(lower))) {
    return false;
  }

  const timeSensitive = [
    /\b(today|tonight|this (week|month|year)|right now|currently|at the moment|as of|latest|recent|newest|breaking|live|aaj|abhi|haali me)\b/,
    /\b(news|headlines|update|announcement|release|launch|event|match|score|result|weather|forecast|stock|price|rate|trend|khabar|samachar)\b/,
    /\b(who (is|are) (the )?(current|new|latest|now|abhi ka))\b/,
    /\b(what (is|are) (the )?(current|latest|new|today'?s?))\b/,
    /\b(how much (does|is|are|kitna|dam|bhav))\b/,
    /\b(is .+ (still|open|available|alive|working|running))\b/,
  ];

  const factualLookup = [
    /\b(who (invented|created|founded|discovered|wrote|made|built|designed|kisne banaya|kisne kiya))\b/,
    /\b(what (year|date|time|place|country|city) (was|is|did|does|kab|kaha))\b/,
    /\b(where (is|are|was|were) .+ (located|based|from|born|founded))\b/,
    /\b(population of|capital of|currency of|president of|prime minister of|vice president of|ceo of|founder of|governor of|chief minister of|district magistrate of|cm of|pm of|dm of|hm of|fm of)\b/,
  ];

  return [...timeSensitive, ...factualLookup].some(pattern => pattern.test(lower));
}

export class IntentDetector {
  detect(message: string, history: ConversationTurn[] = []): IntentResult {
    const contextualMessage = buildContextualMessage(message, history);
    const normalizedMessage = smartNormalize(contextualMessage);
    const lower = normalizedMessage;

    const candidates: ScoredIntent[] = [
      this.detectImageGeneration(lower, contextualMessage, message),
      this.detectCodeGeneration(lower, contextualMessage, message),
      this.detectTranslation(lower, contextualMessage),
      this.detectSentiment(lower, contextualMessage),
      this.detectGrammar(lower, contextualMessage),
      this.detectQuiz(lower, contextualMessage),
      this.detectRecipe(lower, contextualMessage),
      this.detectJoke(lower, contextualMessage),
      this.detectDictionary(lower, contextualMessage),
      this.detectFactCheck(lower, contextualMessage),
      this.detectExplanation(lower, contextualMessage, message, history),
      this.detectWebSearch(lower, contextualMessage, message),
      {
        intent: 'CHAT',
        confidence: 0.55,
        extractedQuery: contextualMessage,
        reasoning: 'General conversation fallback',
      },
    ];

    return candidates.sort((a, b) => b.confidence - a.confidence)[0];
  }

  private detectWebSearch(lower: string, contextualMessage: string, rawMessage: string): IntentResult {
    const explanationSignal = hasExplicitExplanationSignal(rawMessage) || isFollowUpExplanation(rawMessage);

    const patterns = [
      { regex: /^(search|google|bing|find|lookup|look up|dhundo|pata karo)\s+(for|about|on)?\s*(.+)/i, weight: 0.99 },
      { regex: /^web\s+search\s+(.+)/i, weight: 0.99 },
      { regex: /^(can you|could you|please)\s+(search|find|look up|get|fetch)/i, weight: 0.92 },
      { regex: /(latest|current|recent|newest|today'?s?|this week'?s?|aaj ka|abhi ka)\s+(news|updates?|information|data|stats?|trends?|khabar|info)/i, weight: 0.92 },
      { regex: /\b(current|latest|today|live|price|weather|score|news|rate|abhi|aaj|live|dam|bhav)\b/i, weight: 0.82 },
      { regex: /\b(vice president of|prime minister of|president of|ceo of|founder of|governor of|chief minister of|district magistrate of|cm of|pm of|dm of|hm of|fm of)\b/i, weight: 0.87 },
    ];

    let maxConfidence = requiresWebSearch(contextualMessage) ? 0.88 : 0;
    let extractedQuery = contextualMessage;
    let matchedPattern = maxConfidence > 0 ? 'requiresWebSearch' : 'none';

    for (const pattern of patterns) {
      const match = rawMessage.match(pattern.regex) || contextualMessage.match(pattern.regex) || lower.match(pattern.regex);
      if (match && pattern.weight > maxConfidence) {
        maxConfidence = pattern.weight;
        matchedPattern = pattern.regex.source;
        extractedQuery = (match[3] || match[1] || contextualMessage).trim();
      }
    }

    if (explanationSignal) {
      maxConfidence = Math.min(maxConfidence, 0.62);
    }

    return {
      intent: 'WEB_SEARCH',
      confidence: Math.min(maxConfidence, 0.99),
      extractedQuery,
      reasoning: `Search intent from ${matchedPattern}`,
    };
  }

  private detectImageGeneration(lower: string, contextualMessage: string, rawMessage: string): IntentResult {
    const patterns = [
      { regex: /^(generate|create|make|draw|paint|design|produce|banao|dikhao|chitra)\s+(an?|the)?\s*(image|picture|photo|illustration|artwork|graphic|photo|pic)\s+(of|showing|depicting|with|ka|ki)?\s*(.+)/i, weight: 0.99 },
      { regex: /^(draw|paint|sketch|illustrate|render|photo)\s+me\s+(.+)/i, weight: 0.94 },
      { regex: /^(draw|paint|sketch|illustrate|render|banao)\s+(.+)/i, weight: 0.86 },
      { regex: /^(image|picture|photo|illustration|pic)\s+(of|showing|depicting|ka|ki)\s+(.+)/i, weight: 0.95 },
      { regex: /^(can you|could you|please)\s+show\s+me\s+(an?|the)?\s*(image|picture|photo|illustration|drawing|painting|sketch)\s+(of|showing|depicting)?\s*(.+)/i, weight: 0.96 },
      { regex: /^(show me|visualize|dikhao)\s+(an?|the)?\s*(image|picture|photo|illustration|drawing|painting|sketch|visualization)\s+(of|showing|depicting)?\s*(.+)/i, weight: 0.95 },
      { regex: /\b(photo-?realistic|artistic|anime|sketch|cartoon|3d|watercolor|digital art)\b/i, weight: 0.84 },
    ];

    let maxConfidence = 0;
    let extractedQuery = contextualMessage;
    let matchedPattern = 'none';

    for (const pattern of patterns) {
      const match = rawMessage.match(pattern.regex) || contextualMessage.match(pattern.regex) || lower.match(pattern.regex);
      if (match && pattern.weight > maxConfidence) {
        maxConfidence = pattern.weight;
        matchedPattern = pattern.regex.source;
        extractedQuery = (match[6] || match[5] || match[3] || match[2] || contextualMessage).trim();
      }
    }

    return {
      intent: 'IMAGE_GENERATION',
      confidence: Math.min(maxConfidence, 0.99),
      extractedQuery,
      reasoning: `Image intent from ${matchedPattern}`,
    };
  }

  private detectCodeGeneration(lower: string, contextualMessage: string, rawMessage: string): IntentResult {
    const patterns = [
      { regex: /^(write|create|generate|make|build|likho|banao)\s+(a|an|the)?\s*([\w-]+\s+){0,3}(function|class|component|script|program|code|api|endpoint|coding)\b/i, weight: 0.95 },
      { regex: /^(code|implement|develop|coding)\s+(a|an|the)?\s*(.+)/i, weight: 0.88 },
      { regex: /\b(python|javascript|typescript|react|node|java|c\+\+|rust|go|sql)\b.*\b(code|function|class|script|component|query|endpoint|program)\b/i, weight: 0.92 },
    ];

    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(rawMessage) || pattern.regex.test(contextualMessage) || pattern.regex.test(lower)) {
        maxConfidence = Math.max(maxConfidence, pattern.weight);
      }
    }

    return {
      intent: 'CODE_GENERATION',
      confidence: Math.min(maxConfidence, 0.99),
      extractedQuery: contextualMessage,
      reasoning: maxConfidence > 0 ? 'Detected code generation request' : 'No code pattern matched',
    };
  }

  private detectExplanation(lower: string, contextualMessage: string, rawMessage: string, history: ConversationTurn[]): IntentResult {
    const patterns = [
      { regex: /^(explain|describe|define|clarify|samjhao|batao)\s+(.+)/i, weight: 0.9 },
      { regex: /^(teach me|help me understand|tell me about|batao)\s+(.+)/i, weight: 0.86 },
      { regex: /^(how does|how do|why does|why do|kaise|kyu)\s+(.+)/i, weight: 0.84 },
      { regex: /^(what about|how about|tell me more about|more about|what else about|aur kya)\s+(.+)/i, weight: history.length > 0 ? 0.8 : 0.62 },
    ];

    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(rawMessage) || pattern.regex.test(contextualMessage) || pattern.regex.test(lower)) {
        maxConfidence = Math.max(maxConfidence, pattern.weight);
      }
    }

    if (requiresWebSearch(contextualMessage) && !(hasExplicitExplanationSignal(rawMessage) || isFollowUpExplanation(rawMessage))) {
      maxConfidence = Math.min(maxConfidence, 0.58);
    }

    return {
      intent: 'EXPLANATION',
      confidence: Math.min(maxConfidence, 0.99),
      extractedQuery: contextualMessage,
      reasoning: maxConfidence > 0 ? 'Detected explanation request' : 'No explanation pattern matched',
    };
  }

  private detectTranslation(lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /^(translate|translation of|anuvad)\s+(.+)\s+(to|into|me)\s+([a-zA-Z]+)/i, weight: 1.0 },
      { regex: /^(translate|say|how (do you|do i) say|kaise bolte hai)\s+(.+)\s+in\s+([a-zA-Z]+)/i, weight: 0.95 },
      { regex: /\b(translate|translation|anuvad)\b/i, weight: 0.8 },
      { regex: /\bin\s+(spanish|french|hindi|german|japanese|chinese|arabic|portuguese|russian|korean|italian|turkish|dutch|polish|swedish|norwegian|danish|finnish|greek|hebrew|thai|vietnamese|indonesian|malay|bengali|urdu|tamil|telugu|marathi|gujarati|punjabi|kannada|malayalam)\b/i, weight: 0.85 },
    ];
    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(original) || pattern.regex.test(lower)) maxConfidence = Math.max(maxConfidence, pattern.weight);
    }
    return { intent: 'TRANSLATION', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected translation request' : 'No translation pattern matched' };
  }

  private detectSentiment(lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(sentiment|emotion|tone|feeling|mood)\s+(of|in|for|analysis)\b/i, weight: 0.9 },
      { regex: /\b(analyze|analyse)\s+(the\s+)?(sentiment|emotion|tone|feeling|mood)\b/i, weight: 0.95 },
      { regex: /\b(is (this|the|my) (text|message|review|comment|post) (positive|negative|neutral))\b/i, weight: 0.9 },
      { regex: /\b(what('?s| is) the (sentiment|tone|emotion|feeling) (of|in))\b/i, weight: 0.9 },
    ];
    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(original) || pattern.regex.test(lower)) maxConfidence = Math.max(maxConfidence, pattern.weight);
    }
    return { intent: 'SENTIMENT_ANALYSIS', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected sentiment analysis request' : 'No sentiment pattern matched' };
  }

  private detectGrammar(lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(grammar|proofread|proofreading|spell.?check|galti|sudharo)\b/i, weight: 0.9 },
      { regex: /\b(correct|fix|improve)\s+(my|this|the)\s+(grammar|spelling|writing|text|essay|email|sentence|shabd)\b/i, weight: 0.95 },
      { regex: /\b(check (my|this|the) (grammar|spelling|writing))\b/i, weight: 0.9 },
      { regex: /\b(rewrite|rephrase|paraphrase)\s+(this|my|the)\b/i, weight: 0.8 },
    ];
    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(original) || pattern.regex.test(lower)) maxConfidence = Math.max(maxConfidence, pattern.weight);
    }
    return { intent: 'GRAMMAR_CHECK', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected grammar check request' : 'No grammar pattern matched' };
  }

  private detectQuiz(lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(quiz|flashcard|flashcards|test|sawal)\b/i, weight: 0.9 },
      { regex: /\b(make|create|generate|banao)\s+(a\s+)?(quiz|test|flashcard|study guide|questions|sawal)\b/i, weight: 0.95 },
      { regex: /\b(test me|quiz me|sawal pucho)\s+(on|about|pe)\b/i, weight: 0.95 },
      { regex: /\b(study (material|guide|questions|cards))\b/i, weight: 0.85 },
    ];
    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(original) || pattern.regex.test(lower)) maxConfidence = Math.max(maxConfidence, pattern.weight);
    }
    return { intent: 'QUIZ_GENERATION', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected quiz generation request' : 'No quiz pattern matched' };
  }

  private detectRecipe(lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(recipe|recipes|recipe|khana|pakwan|dish)\b/i, weight: 0.9 },
      { regex: /\b(how (to|do i) (cook|make|bake|prepare|grill|fry|boil|banaye|banaye))\b/i, weight: 0.9 },
      { regex: /\b(what (can|should) i (cook|make|eat|prepare|khaye|banaye))\b/i, weight: 0.85 },
      { regex: /\b(ingredients (for|to make|ke liye))\b/i, weight: 0.9 },
      { regex: /\b(dish|meal|food idea|dinner idea|lunch idea|breakfast idea|khana)\b/i, weight: 0.75 },
    ];
    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(original) || pattern.regex.test(lower)) maxConfidence = Math.max(maxConfidence, pattern.weight);
    }
    return { intent: 'RECIPE', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected recipe request' : 'No recipe pattern matched' };
  }

  private detectJoke(lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(tell (me )?(a )?(joke|pun|riddle|fun fact|majak|chutkula|kahani))\b/i, weight: 0.95 },
      { regex: /\b(make me (laugh|smile|hasao))\b/i, weight: 0.9 },
      { regex: /\b(roast me|roast (my|this))\b/i, weight: 0.95 },
      { regex: /\b(give me a (joke|pun|riddle|compliment|pickup line|fun fact|majak))\b/i, weight: 0.95 },
      { regex: /\b(something funny|be funny|be witty|majak karo)\b/i, weight: 0.8 },
    ];
    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(original) || pattern.regex.test(lower)) maxConfidence = Math.max(maxConfidence, pattern.weight);
    }
    return { intent: 'JOKE', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected joke/fun request' : 'No joke pattern matched' };
  }

  private detectDictionary(lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /^(define|definition of|what does .+ mean|meaning of|matlab|arth)\b/i, weight: 0.95 },
      { regex: /\b(synonym(s)? (of|for)|antonym(s)? (of|for)|paryayvachi|vilom)\b/i, weight: 0.9 },
      { regex: /\b(etymology of|word origin of|history of the word)\b/i, weight: 0.9 },
      { regex: /\b(what is the meaning of|what does .+ mean|kya matlab hai)\b/i, weight: 0.9 },
      { regex: /\b(look up the word|dictionary (entry|definition) (for|of)|shabdkosh)\b/i, weight: 0.95 },
    ];
    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(original) || pattern.regex.test(lower)) maxConfidence = Math.max(maxConfidence, pattern.weight);
    }
    return { intent: 'DICTIONARY', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected dictionary lookup request' : 'No dictionary pattern matched' };
  }

  private detectFactCheck(lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(fact.?check|fact checking|sahi hai|sach hai)\b/i, weight: 0.95 },
      { regex: /\b(is it true (that)?|is (this|that) true|kya ye sahi hai)\b/i, weight: 0.9 },
      { regex: /\b(verify (that|this|the claim|the fact))\b/i, weight: 0.9 },
      { regex: /\b(debunk|myth or fact|true or false|is .+ a myth)\b/i, weight: 0.9 },
      { regex: /\b(did .+ really|is it a fact that)\b/i, weight: 0.85 },
    ];
    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(original) || pattern.regex.test(lower)) maxConfidence = Math.max(maxConfidence, pattern.weight);
    }
    return { intent: 'FACT_CHECK', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected fact-check request' : 'No fact-check pattern matched' };
  }
}

let _instance: IntentDetector | null = null;
export function getIntentDetector(): IntentDetector {
  if (!_instance) _instance = new IntentDetector();
  return _instance;
}
