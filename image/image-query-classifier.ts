/**
 * Image Query Classifier
 * ════════════════════════════════════════════════════════════════════════════
 * Classifies what kind of image the user wants and extracts structured data
 * from natural language requests like:
 *   "generate a poster for Manik's marriage anniversary"
 *   "draw a sunset over mountains in anime style"
 *   "create a birthday card for my sister"
 *
 * Output feeds directly into the prompt engineer to build a rich visual prompt.
 */

export type ImageCategory =
  | 'poster'          // celebration poster, event poster, announcement
  | 'greeting_card'   // birthday card, anniversary card, wish card
  | 'wallpaper'       // desktop/phone wallpaper, background
  | 'portrait'        // person portrait, character art
  | 'landscape'       // scenery, nature, cityscape
  | 'logo'            // brand logo, icon, emblem
  | 'banner'          // website banner, social media banner
  | 'illustration'    // general illustration, concept art
  | 'meme'            // meme template, funny image
  | 'general';        // anything else

export type OccasionType =
  | 'birthday'
  | 'anniversary'
  | 'wedding'
  | 'graduation'
  | 'new_year'
  | 'diwali'
  | 'eid'
  | 'christmas'
  | 'holi'
  | 'farewell'
  | 'congratulations'
  | 'get_well'
  | 'thank_you'
  | 'none';

export interface ImageClassification {
  category: ImageCategory;
  occasion: OccasionType;
  /** Names extracted from the prompt (e.g. "Manik", "Sarah") */
  names: string[];
  /** Style hints extracted (e.g. "elegant", "anime", "minimalist") */
  styleHints: string[];
  /** Color hints (e.g. "gold", "blue", "pastel") */
  colorHints: string[];
  /** The cleaned subject/scene description without meta-instructions */
  cleanSubject: string;
  /** Whether this is a text-heavy design (poster/card) vs pure visual */
  isTextDesign: boolean;
  /** Suggested aspect ratio */
  aspectRatio: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
}

// ─── Pattern tables ───────────────────────────────────────────────────────────

const CATEGORY_PATTERNS: Array<{ pattern: RegExp; category: ImageCategory }> = [
  { pattern: /\b(poster|flyer|announcement|notice board)\b/i,                    category: 'poster' },
  { pattern: /\b(greeting card|wish card|birthday card|anniversary card|e-?card)\b/i, category: 'greeting_card' },
  { pattern: /\b(wallpaper|background|desktop|phone background|lock screen)\b/i, category: 'wallpaper' },
  { pattern: /\b(portrait|headshot|profile pic|character|person|face)\b/i,       category: 'portrait' },
  { pattern: /\b(landscape|scenery|nature|mountain|ocean|forest|cityscape|skyline)\b/i, category: 'landscape' },
  { pattern: /\b(logo|icon|emblem|brand|symbol|badge)\b/i,                       category: 'logo' },
  { pattern: /\b(banner|header|cover|social media|thumbnail|youtube)\b/i,        category: 'banner' },
  { pattern: /\b(meme|funny|joke image|reaction)\b/i,                            category: 'meme' },
  { pattern: /\b(illustration|concept art|artwork|drawing|painting|sketch)\b/i,  category: 'illustration' },
];

const OCCASION_PATTERNS: Array<{ pattern: RegExp; occasion: OccasionType }> = [
  { pattern: /\b(birthday|bday|born|janmdin|janamdin)\b/i,                       occasion: 'birthday' },
  { pattern: /\b(marriage anniversary|wedding anniversary|anniversary)\b/i,       occasion: 'anniversary' },
  { pattern: /\b(wedding|shaadi|vivah|marriage ceremony|nuptial)\b/i,             occasion: 'wedding' },
  { pattern: /\b(graduation|convocation|degree|pass out|passed out)\b/i,          occasion: 'graduation' },
  { pattern: /\b(new year|naya saal|happy new year)\b/i,                          occasion: 'new_year' },
  { pattern: /\b(diwali|deepawali|deepavali)\b/i,                                 occasion: 'diwali' },
  { pattern: /\b(eid|eid mubarak|ramadan|bakrid)\b/i,                             occasion: 'eid' },
  { pattern: /\b(christmas|xmas|merry christmas)\b/i,                             occasion: 'christmas' },
  { pattern: /\b(holi|rang panchami)\b/i,                                         occasion: 'holi' },
  { pattern: /\b(farewell|goodbye|bon voyage|leaving|retirement)\b/i,             occasion: 'farewell' },
  { pattern: /\b(congratulations|congrats|well done|achievement|success)\b/i,     occasion: 'congratulations' },
  { pattern: /\b(get well|speedy recovery|feel better|health)\b/i,                occasion: 'get_well' },
  { pattern: /\b(thank you|thanks|gratitude|grateful)\b/i,                        occasion: 'thank_you' },
];

const STYLE_PATTERNS: Array<{ pattern: RegExp; style: string }> = [
  { pattern: /\b(elegant|luxury|premium|sophisticated|classy)\b/i,  style: 'elegant' },
  { pattern: /\b(minimalist|minimal|clean|simple)\b/i,              style: 'minimalist' },
  { pattern: /\b(vibrant|colorful|bright|vivid|bold)\b/i,           style: 'vibrant' },
  { pattern: /\b(anime|manga|japanese animation)\b/i,               style: 'anime' },
  { pattern: /\b(realistic|photorealistic|photo-?real)\b/i,         style: 'photorealistic' },
  { pattern: /\b(watercolor|watercolour|painted)\b/i,               style: 'watercolor' },
  { pattern: /\b(vintage|retro|classic|old school)\b/i,             style: 'vintage' },
  { pattern: /\b(modern|contemporary|sleek|futuristic)\b/i,         style: 'modern' },
  { pattern: /\b(cute|kawaii|adorable|sweet)\b/i,                   style: 'cute' },
  { pattern: /\b(dark|gothic|moody|dramatic)\b/i,                   style: 'dark' },
  { pattern: /\b(floral|flowers|botanical|nature-?inspired)\b/i,    style: 'floral' },
  { pattern: /\b(3d|three.?dimensional|3d render)\b/i,              style: '3d' },
];

const COLOR_PATTERNS: Array<{ pattern: RegExp; color: string }> = [
  { pattern: /\b(gold|golden)\b/i,    color: 'gold' },
  { pattern: /\b(silver|metallic)\b/i, color: 'silver' },
  { pattern: /\b(red|crimson|scarlet)\b/i, color: 'red' },
  { pattern: /\b(blue|navy|cobalt|azure)\b/i, color: 'blue' },
  { pattern: /\b(green|emerald|forest green)\b/i, color: 'green' },
  { pattern: /\b(purple|violet|lavender)\b/i, color: 'purple' },
  { pattern: /\b(pink|rose|blush)\b/i, color: 'pink' },
  { pattern: /\b(white|ivory|cream)\b/i, color: 'white' },
  { pattern: /\b(black|dark|charcoal)\b/i, color: 'black' },
  { pattern: /\b(orange|amber|coral)\b/i, color: 'orange' },
  { pattern: /\b(yellow|sunshine|lemon)\b/i, color: 'yellow' },
  { pattern: /\b(pastel|soft colors|muted)\b/i, color: 'pastel' },
];

// ─── Name extraction ──────────────────────────────────────────────────────────

/**
 * Extract proper names from the prompt.
 * Looks for patterns like "name Manik", "for Manik", "my friend Manik", etc.
 */
function extractNames(text: string): string[] {
  const names: string[] = [];

  // "name X" or "named X"
  const namePatterns = [
    /\bname[d]?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g,
    /\bfor\s+(?:my\s+)?(?:friend|brother|sister|mom|dad|mother|father|wife|husband|partner|colleague|boss|teacher|student|son|daughter|uncle|aunt|cousin|grandma|grandpa|grandfather|grandmother)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g,
    /\b(?:wish|wishing|congratulate|congratulating)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g,
    /\bto\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:on|for|who)\b/g,
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)'s\s+(?:birthday|anniversary|wedding|graduation)\b/g,
  ];

  for (const pattern of namePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1]?.trim();
      if (name && name.length > 1 && !['Happy', 'Wish', 'Dear', 'The', 'This', 'That', 'Please', 'Generate', 'Create', 'Make'].includes(name)) {
        names.push(name);
      }
    }
  }

  return [...new Set(names)];
}

// ─── Subject cleaning ─────────────────────────────────────────────────────────

/**
 * Remove meta-instructions from the prompt to get the pure visual subject.
 * e.g. "generate a poster to wish him Happy marriage anniversary" → "marriage anniversary celebration"
 */
function cleanSubject(text: string): string {
  return text
    .replace(/\b(generate|create|make|draw|paint|design|produce|show me|give me|i want|i need|please|can you|could you)\b/gi, '')
    .replace(/\b(an?|the|a)\s+(image|picture|photo|illustration|artwork|graphic|pic|poster|banner|card|wallpaper|logo)\b/gi, '')
    .replace(/\b(of|for|showing|depicting|featuring|about)\b/gi, '')
    .replace(/\b(to wish|to celebrate|to congratulate|to mark)\b/gi, '')
    .replace(/\b(him|her|them|my friend|my brother|my sister|my mom|my dad)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Aspect ratio selection ───────────────────────────────────────────────────

function selectAspectRatio(category: ImageCategory, occasion: OccasionType): '1:1' | '16:9' | '9:16' | '4:3' | '3:4' {
  switch (category) {
    case 'poster':       return '3:4';   // Portrait poster
    case 'greeting_card': return '4:3';  // Landscape card
    case 'wallpaper':    return '16:9';  // Widescreen
    case 'banner':       return '16:9';  // Wide banner
    case 'portrait':     return '3:4';   // Portrait orientation
    case 'logo':         return '1:1';   // Square logo
    default:             return '1:1';   // Default square
  }
}

// ─── Main classifier ──────────────────────────────────────────────────────────

export function classifyImageRequest(userPrompt: string): ImageClassification {
  const text = userPrompt;

  // Category
  let category: ImageCategory = 'general';
  for (const { pattern, category: cat } of CATEGORY_PATTERNS) {
    if (pattern.test(text)) { category = cat; break; }
  }

  // Occasion
  let occasion: OccasionType = 'none';
  for (const { pattern, occasion: occ } of OCCASION_PATTERNS) {
    if (pattern.test(text)) { occasion = occ; break; }
  }

  // If occasion detected but no category, infer category
  if (occasion !== 'none' && category === 'general') {
    if (/\b(poster|banner)\b/i.test(text)) category = 'poster';
    else if (/\b(card|wish|greeting)\b/i.test(text)) category = 'greeting_card';
    else category = 'poster'; // default for occasion-based requests
  }

  // Style hints
  const styleHints: string[] = [];
  for (const { pattern, style } of STYLE_PATTERNS) {
    if (pattern.test(text)) styleHints.push(style);
  }

  // Color hints
  const colorHints: string[] = [];
  for (const { pattern, color } of COLOR_PATTERNS) {
    if (pattern.test(text)) colorHints.push(color);
  }

  // Names
  const names = extractNames(text);

  // Clean subject
  const cleanedSubject = cleanSubject(text);

  // Is text design?
  const isTextDesign = ['poster', 'greeting_card', 'banner', 'logo'].includes(category);

  // Aspect ratio
  const aspectRatio = selectAspectRatio(category, occasion);

  return {
    category,
    occasion,
    names,
    styleHints,
    colorHints,
    cleanSubject: cleanedSubject,
    isTextDesign,
    aspectRatio,
  };
}
