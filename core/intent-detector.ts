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
 * Expands short forms (CM, PM, DM, etc.) and handles Hinglish commonalities
 */
function smartNormalize(text: string): string {
  let low = text.toLowerCase().trim();
  
  // Title & Administrative Expansions
  const expansions: Record<string, string> = {
    'pm': 'prime minister',
    'cm': 'chief minister',
    'dm': 'district magistrate',
    'hm': 'home minister',
    'fm': 'finance minister',
    'rm': 'railway minister',
    'vp': 'vice president',
    'vpm': 'vice president',
    'prez': 'president',
    'gov': 'governor',
    'mla': 'member of legislative assembly',
    'mp': 'member of parliament',
    'sp': 'superintendent of police',
    'ssp': 'senior superintendent of police',
    'dgp': 'director general of police',
    'sho': 'station house officer',
    'ias': 'indian administrative service',
    'ips': 'indian police service',
    'ifs': 'indian foreign service',
    'irs': 'indian revenue service',
    'dr': 'doctor',
    'prof': 'professor',
    'vc': 'vice chancellor',
    'hod': 'head of department',
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
    /\b(this|that|it|same|again|more|continue|also|why|how about|what about|role|details|kya|kyu|kaise|kaha|kab|kon|kisne|kiska)\b/i.test(trimmed) ||
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
  return /^(explain|describe|clarify|teach me|help me understand|tell me about|samjhao|batao|kya hai|kya hota hai|vistar se|detail me)\b/i.test(message.trim());
}

function isFollowUpExplanation(message: string): boolean {
  return /^(what about|how about|tell me more about|more about|what else about|kya|kyu|aur batao|aur kya)\b/i.test(message.trim());
}

function hasExplicitNonSearchSignal(message: string): boolean {
  return (
    hasExplicitExplanationSignal(message) ||
    /\b(grammar|proofread|proofreading|spell.?check|rewrite|rephrase|paraphrase|galti|sudharo|theek karo)\b/i.test(message) ||
    /\b(sentiment|emotion|tone|mood|feeling|ehsas|bhavna)\b/i.test(message) ||
    /\b(quiz|flashcard|recipe|joke|riddle|define|definition|meaning of|fact.?check|khana|pakwan|majak|kahani|matlab|arth|sahi hai|vidhi|samagri|full.?form)\b/i.test(message) ||
    /\b(write|build|create|generate|make|implement|develop|likho|banao|code likho)\b.+\b(function|class|component|script|program|code|api|endpoint|program|app|coding|logic)\b/i.test(message)
  );
}

export function requiresWebSearch(message: string): boolean {
  const lower = smartNormalize(message);

  if (hasExplicitNonSearchSignal(message)) {
    return false;
  }

  const explicitSolveSignals = [
    /\b(solve|calculate|simplify|evaluate|integrate|differentiate|factorize|derive|prove|hal karo|nikalo|solve karo)\b/,
    /\b(equation|expression|formula|matrix|determinant|polynomial|integral|derivative|sutra|sawal|pariksha)\b/,
  ];

  if (explicitSolveSignals.some(pattern => pattern.test(lower))) {
    return false;
  }

  const timeSensitive = [
    /\b(today|tonight|this (week|month|year)|right now|currently|at the moment|as of|latest|recent|newest|breaking|live|aaj|abhi|haali me|hal hi me|turant)\b/,
    /\b(news|headlines|update|announcement|release|launch|event|match|score|result|weather|forecast|stock|price|rate|trend|khabar|samachar|taza|mausam|baarish)\b/,
    /\b(who (is|are) (the )?(current|new|latest|now|abhi ka|is waqt))\b/,
    /\b(what (is|are) (the )?(current|latest|new|today'?s?|aaj ka))\b/,
    /\b(how much (does|is|are|kitna|dam|bhav|kimat|paise|paisa))\b/,
    /\b(is .+ (still|open|available|alive|working|running))\b/,
  ];

  const factualLookup = [
    /\b(who (invented|created|founded|discovered|wrote|made|built|designed|kisne banaya|kisne kiya|kaun hai))\b/,
    /\b(what (year|date|time|place|country|city) (was|is|did|does|kab|kaha|kon sa))\b/,
    /\b(where (is|are|was|were) .+ (located|based|from|born|founded|kaha par hai))\b/,
    /\b(population of|capital of|currency of|president of|prime minister of|vice president of|ceo of|founder of|governor of|chief minister of|district magistrate of|cm|pm|dm|hm|fm|rm|sp|sho|ias|ips)\b/,
    /\b(kaun hai|kya hai|kab hua|kaha hai|kaise hua|kisne kiya)\b/i, // Standalone Hinglish questions
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
      { regex: /\b(search|google|bing|find|lookup|look up|dhundo|pata karo|search karo|pata lagao)\b/i, weight: 0.95 },
      { regex: /\bweb\s+search\b/i, weight: 0.99 },
      { regex: /(latest|current|recent|newest|today'?s?|this week'?s?|aaj ka|abhi ka|hal hi me)\s+(news|updates?|information|data|stats?|trends?|khabar|info|samachar|jankari|taza)/i, weight: 0.92 },
      { regex: /\b(current|latest|today|live|price|weather|score|news|rate|abhi|aaj|live|dam|bhav|kimat|paise|paisa|taza)\b/i, weight: 0.82 },
      // Factual Lookups - Registered for high-priority web search
      { regex: /\b(who (invented|created|founded|discovered|wrote|made|built|designed|kisne banaya|kisne kiya|kaun hai))\b/i, weight: 0.98 },
      { regex: /\b(what (year|date|time|place|country|city) (was|is|did|does|kab|kaha|kon sa))\b/i, weight: 0.98 },
      { regex: /\b(where (is|are|was|were) .+ (located|based|from|born|founded|kaha par hai))\b/i, weight: 0.98 },
      { regex: /\b(population of|capital of|currency of|president of|prime minister of|vice president of|ceo of|founder of|governor of|chief minister of|district magistrate of|cm|pm|dm|hm|fm|rm|sp|sho|ias|ips)\b/i, weight: 0.97 },
      { regex: /\b(kaun hai|kya hai|kab hua|kaha hai|jankari do|pata karo)\b/i, weight: 0.96 },
    ];

    let maxConfidence = requiresWebSearch(contextualMessage) ? 0.88 : 0;
    let extractedQuery = contextualMessage;
    let matchedPattern = maxConfidence > 0 ? 'requiresWebSearch' : 'none';

    let factualMatch = false;
    for (const pattern of patterns) {
      const match = rawMessage.match(pattern.regex) || contextualMessage.match(pattern.regex) || lower.match(pattern.regex);
      if (match && pattern.weight > maxConfidence) {
        maxConfidence = pattern.weight;
        matchedPattern = pattern.regex.source;
        extractedQuery = contextualMessage.replace(pattern.regex, '').replace(/\s+/g, ' ').trim() || contextualMessage;
        if (pattern.weight >= 0.96) factualMatch = true;
      }
    }

    if (explanationSignal && !factualMatch) {
      maxConfidence = Math.min(maxConfidence, 0.62);
    } else if (explanationSignal && factualMatch) {
      maxConfidence = Math.min(maxConfidence, 0.85);
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
      // Explicit generate/create/make + image noun
      { regex: /\b(generate|create|make|draw|paint|design|produce|banao|dikhao|chitra|tasveer|photo)\s+(an?|the|me|a)?\s*(image|picture|photo|illustration|artwork|graphic|pic|painting|sketch|drawing|wallpaper|poster|logo|banner|thumbnail|avatar|portrait|landscape|scene|render|card|flyer)\b/i, weight: 0.99 },
      // Draw/paint/sketch/render me
      { regex: /\b(draw|paint|sketch|illustrate|render|visualize|imagine|depict)\s+(me|a|an|the|this|that)?\b/i, weight: 0.97 },
      // Image of / picture of / photo of
      { regex: /\b(image|picture|photo|illustration|pic|tasveer|chitra|painting|sketch|drawing|artwork)\s+(of|showing|depicting|with|featuring|about|ka|ki)\b/i, weight: 0.97 },
      // Show me a/an image/picture
      { regex: /\b(show|display|give|send)\s+(me\s+)?(an?|the)?\s*(image|picture|photo|illustration|drawing|painting|sketch|visual|artwork)\b/i, weight: 0.96 },
      // I want/need an image
      { regex: /\b(i\s+)?(want|need|would like|can you make|could you make|please make|please create|please generate|please draw)\s+(an?|the|me\s+an?)?\s*(image|picture|photo|illustration|drawing|painting|sketch|artwork)\b/i, weight: 0.97 },
      // Art styles as strong signals
      { regex: /\b(photo-?realistic|photorealistic|artistic|anime|manga|sketch|cartoon|3d render|watercolor|oil painting|digital art|pixel art|concept art|fantasy art|sci-fi art|portrait|landscape painting|abstract art)\b/i, weight: 0.88 },
      // Hinglish image requests
      { regex: /\b(tasveer|chitra|photo|pic)\s+(bana|banao|dikhao|chahiye|chahie)\b/i, weight: 0.98 },
      // "create a visual" / "generate a visual"
      { regex: /\b(create|generate|make|produce)\s+(a\s+)?(visual|graphic|render|artwork|illustration|wallpaper|poster|logo|banner|thumbnail|avatar|greeting card|wish card|birthday card|anniversary card)\b/i, weight: 0.96 },
      // Standalone "generate image" or "image generate"
      { regex: /\b(generate\s+image|image\s+generate|create\s+image|image\s+create|make\s+image|image\s+maker)\b/i, weight: 0.99 },

      // ── POSTER / CARD / WISH requests (the main gap being fixed) ──────────
      // "generate a poster for X"
      { regex: /\b(generate|create|make|design|produce)\s+(a\s+)?(poster|banner|flyer|card|greeting card|wish card|e-?card)\b/i, weight: 0.99 },
      // "poster to wish" / "poster for anniversary" / "poster for birthday"
      { regex: /\b(poster|banner|card|flyer)\s+(to\s+)?(wish|for|celebrating|about|on)\b/i, weight: 0.98 },
      // "wish poster" / "anniversary poster" / "birthday poster"
      { regex: /\b(wish|birthday|anniversary|wedding|graduation|diwali|eid|christmas|holi|farewell|congratulations)\s+(poster|banner|card|image|picture|graphic|flyer)\b/i, weight: 0.99 },
      // "poster for [name]" or "poster for my friend"
      { regex: /\b(poster|banner|card|flyer)\s+(for\s+)?(my\s+)?(friend|brother|sister|mom|dad|wife|husband|partner|colleague|[A-Z][a-z]+)\b/i, weight: 0.97 },
      // "happy birthday poster" / "happy anniversary image"
      { regex: /\bhappy\s+(birthday|anniversary|diwali|eid|holi|new year|christmas)\s+(poster|banner|card|image|picture|graphic|flyer|wallpaper)\b/i, weight: 0.99 },
      // "create a wish image" / "make a celebration graphic"
      { regex: /\b(create|make|generate|design)\s+(a\s+)?(wish|celebration|festive|greeting|congratulation)\s+(image|picture|graphic|poster|card|banner)\b/i, weight: 0.98 },
    ];

    let maxConfidence = 0;
    let extractedQuery = contextualMessage;
    let matchedPattern = 'none';

    for (const pattern of patterns) {
      const match = rawMessage.match(pattern.regex) || contextualMessage.match(pattern.regex) || lower.match(pattern.regex);
      if (match && pattern.weight > maxConfidence) {
        maxConfidence = pattern.weight;
        matchedPattern = pattern.regex.source;
        extractedQuery = contextualMessage;
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
      { regex: /\b(write|create|generate|make|build|likho|banao|code likho|script banao)\b.*\b(function|class|component|script|program|code|api|endpoint|coding|logic|app)\b/i, weight: 0.95 },
      { regex: /\b(python|javascript|typescript|react|node|java|c\+\+|rust|go|sql)\b.*\b(code|function|class|script|component|query|endpoint|program|likho|banao)\b/i, weight: 0.92 },
      { regex: /\b(code|coding|logic|algorithm)\b/i, weight: 0.75 },
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
      { regex: /\b(explain|describe|define|clarify|samjhao|batao|vistar se|samjhaiye)\b/i, weight: 0.92 },
      { regex: /\b(teach me|help me understand|tell me about|batao|kya hai)\b/i, weight: 0.88 },
      { regex: /\b(how does|how do|why does|why do|kaise|kyu|kaise hota hai)\b/i, weight: 0.84 },
      { regex: /\b(what about|how about|tell me more about|more about|what else about|aur kya|aur batao)\b/i, weight: history.length > 0 ? 0.8 : 0.62 },
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
      { regex: /\b(translate|translation of|anuvad|badlo|anuvad karo)\b.*\b(to|into|me|bhasha me)\b/i, weight: 1.0 },
      { regex: /\b(translate|say|how (do you|do i) say|kaise bolte hai|kaise kahe)\b/i, weight: 0.95 },
      { regex: /\b(translate|translation|anuvad|bhasha|bolte)\b/i, weight: 0.8 },
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
      { regex: /\b(sentiment|emotion|tone|feeling|mood|ehsas|bhavna)\b/i, weight: 0.9 },
      { regex: /\b(analyze|analyse)\s+(the\s+)?(sentiment|emotion|tone|feeling|mood|bhav)\b/i, weight: 0.95 },
      { regex: /\b(is (this|the|my) (text|message|review|comment|post) (positive|negative|neutral))\b/i, weight: 0.9 },
      { regex: /\b(what('?s| is) the (sentiment|tone|emotion|feeling|mood) (of|in))\b/i, weight: 0.9 },
    ];
    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(original) || pattern.regex.test(lower)) maxConfidence = Math.max(maxConfidence, pattern.weight);
    }
    return { intent: 'SENTIMENT_ANALYSIS', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected sentiment analysis request' : 'No sentiment pattern matched' };
  }

  private detectGrammar(lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(grammar|proofread|proofreading|spell.?check|galti|sudharo|theek karo)\b/i, weight: 0.9 },
      { regex: /\b(correct|fix|improve|theek)\s+(my|this|the)\s+(grammar|spelling|writing|text|essay|email|sentence|shabd|vaky)\b/i, weight: 0.95 },
      { regex: /\b(check (my|this|the) (grammar|spelling|writing))\b/i, weight: 0.9 },
      { regex: /\b(rewrite|rephrase|paraphrase)\b/i, weight: 0.8 },
    ];
    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(original) || pattern.regex.test(lower)) maxConfidence = Math.max(maxConfidence, pattern.weight);
    }
    return { intent: 'GRAMMAR_CHECK', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected grammar check request' : 'No grammar pattern matched' };
  }

  private detectQuiz(lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(quiz|flashcard|flashcards|test|sawal|pariksha)\b/i, weight: 0.9 },
      { regex: /\b(make|create|generate|banao)\s+(a\s+)?(quiz|test|flashcard|study guide|questions|sawal|paper)\b/i, weight: 0.95 },
      { regex: /\b(test me|quiz me|sawal pucho|test lo)\b/i, weight: 0.95 },
      { regex: /\b(study (material|guide|questions|cards|padhai))\b/i, weight: 0.85 },
    ];
    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(original) || pattern.regex.test(lower)) maxConfidence = Math.max(maxConfidence, pattern.weight);
    }
    return { intent: 'QUIZ_GENERATION', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected quiz generation request' : 'No quiz pattern matched' };
  }

  private detectRecipe(lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(recipe|recipes|recipe|khana|pakwan|dish|vidhi|rasoi)\b/i, weight: 0.92 },
      { regex: /\b(how (to|do i) (cook|make|bake|prepare|grill|fry|boil|banaye|banaye|kaise banaye))\b/i, weight: 0.94 },
      { regex: /\b(kaise (banaye|banaye|banate hai))\b/i, weight: 0.96 },
      { regex: /\b(what (can|should) i (cook|make|eat|prepare|khaye|banaye))\b/i, weight: 0.85 },
      { regex: /\b(ingredients (for|to make|ke liye|samagri))\b/i, weight: 0.9 },
    ];
    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(original) || pattern.regex.test(lower)) maxConfidence = Math.max(maxConfidence, pattern.weight);
    }
    return { intent: 'RECIPE', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected recipe request' : 'No recipe pattern matched' };
  }

  private detectJoke(lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(tell (me )?(a )?(joke|pun|riddle|fun fact|majak|chutkula|kahani|loksukhti))\b/i, weight: 0.95 },
      { regex: /\b(chutkula|majak|kahani|hasao|roast)\b/i, weight: 0.98 },
      { regex: /\b(make me (laugh|smile|hasao))\b/i, weight: 0.9 },
      { regex: /\b(roast me|roast (my|this))\b/i, weight: 0.95 },
      { regex: /\b(something funny|be funny|be witty|majak karo|kuch hasao)\b/i, weight: 0.8 },
    ];
    let maxConfidence = 0;
    for (const pattern of patterns) {
      if (pattern.regex.test(original) || pattern.regex.test(lower)) maxConfidence = Math.max(maxConfidence, pattern.weight);
    }
    return { intent: 'JOKE', confidence: maxConfidence, extractedQuery: original, reasoning: maxConfidence > 0 ? 'Detected joke/fun request' : 'No joke pattern matched' };
  }

  private detectDictionary(lower: string, original: string): IntentResult {
    const patterns = [
      { regex: /\b(define|definition of|meaning of|matlab|arth|paryayvachi|vilom|full.?form)\b/i, weight: 0.99 },
      { regex: /\b(synonym(s)? (of|for)|antonym(s)? (of|for)|paryayvachi|vilom|same word|opposite)\b/i, weight: 0.9 },
      { regex: /\b(etymology of|word origin of|history of the word)\b/i, weight: 0.9 },
      { regex: /\b(what is the meaning of|what does .+ mean|kya matlab hai|kya arth hai)\b/i, weight: 0.95 },
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
      { regex: /\b(fact.?check|fact checking|sahi hai|sach hai|asli hai)\b/i, weight: 0.97 },
      { regex: /\b(is it true (that)?|is (this|that) true|kya ye sahi hai|kya ye sach hai)\b/i, weight: 0.95 },
      { regex: /\b(verify (that|this|the claim|the fact|check karo))\b/i, weight: 0.9 },
      { regex: /\b(debunk|myth or fact|true or false|is .+ a myth|galat)\b/i, weight: 0.9 },
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
