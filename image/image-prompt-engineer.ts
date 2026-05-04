/**
 * Image Prompt Engineer
 * ════════════════════════════════════════════════════════════════════════════
 * Transforms natural language image requests into rich, detailed visual prompts
 * that image generation models (FLUX, Stable Diffusion) understand well.
 *
 * Input:  "generate a poster to wish Manik Happy marriage anniversary"
 * Output: "A stunning marriage anniversary celebration poster for Manik.
 *          Elegant design with romantic roses, golden ornamental borders,
 *          soft warm lighting. Bold decorative text reads 'Happy Marriage
 *          Anniversary Manik'. Rich gold and white color palette.
 *          Professional graphic design, high resolution, print quality."
 *
 * The engineer uses:
 *   1. ImageClassification from the query classifier
 *   2. Occasion-specific visual templates
 *   3. Category-specific composition rules
 *   4. Style and quality boosters
 *   5. Negative prompt guidance (what to avoid)
 */

import { classifyImageRequest, type ImageClassification, type OccasionType, type ImageCategory } from './image-query-classifier';

export interface EngineeredPrompt {
  positive: string;       // The full enriched prompt for the image model
  negative: string;       // What to avoid (passed to models that support it)
  aspectRatio: string;    // Suggested aspect ratio
  classification: ImageClassification;
}

// ─── Occasion visual templates ────────────────────────────────────────────────

const OCCASION_VISUALS: Record<OccasionType, string> = {
  anniversary:     'romantic roses, golden rings, heart motifs, soft candlelight, elegant floral arrangements, anniversary ribbon',
  birthday:        'colorful balloons, birthday cake with candles, confetti, streamers, festive decorations, party atmosphere',
  wedding:         'white roses, wedding rings, bridal flowers, elegant lace patterns, soft bokeh, romantic atmosphere',
  graduation:      'graduation cap and diploma, academic achievement symbols, gold stars, laurel wreath, university colors',
  new_year:        'fireworks, champagne glasses, countdown clock, sparkles, midnight sky, celebration confetti',
  diwali:          'diyas (oil lamps), rangoli patterns, fireworks, marigold flowers, golden light, festive colors',
  eid:             'crescent moon and star, mosque silhouette, lanterns, geometric Islamic patterns, warm golden light',
  christmas:       'Christmas tree, snowflakes, holly berries, red and green colors, warm fireplace, gift boxes',
  holi:            'colorful powder clouds, vibrant splashes of color, flowers, joyful celebration, rainbow colors',
  farewell:        'sunset symbolism, journey motifs, open road, stars, warm golden tones, memories collage',
  congratulations: 'gold stars, trophy, laurel wreath, confetti, achievement symbols, celebratory colors',
  get_well:        'flowers, sunshine, warm colors, healing symbols, gentle nature elements, hopeful imagery',
  thank_you:       'flowers, warm golden tones, gratitude symbols, elegant simplicity, heartfelt imagery',
  none:            '',
};

// ─── Category composition rules ───────────────────────────────────────────────

const CATEGORY_COMPOSITION: Record<ImageCategory, string> = {
  poster:        'vertical poster layout, bold typography area at top and bottom, centered focal image, professional graphic design, print-ready quality',
  greeting_card: 'greeting card layout, warm and personal design, space for message, decorative border, heartfelt aesthetic',
  wallpaper:     'widescreen composition, immersive scene, no text overlay, high detail, suitable as desktop background',
  portrait:      'portrait composition, subject centered, shallow depth of field, professional lighting, detailed face',
  landscape:     'wide panoramic composition, dramatic sky, depth and perspective, natural lighting, scenic beauty',
  logo:          'clean vector-style design, simple and memorable, scalable, minimal colors, professional brand identity',
  banner:        'horizontal banner layout, bold headline area, clean background, professional marketing design',
  illustration:  'detailed illustration, artistic composition, expressive style, rich detail, storytelling imagery',
  meme:          'clear subject, space for text overlay, high contrast, recognizable composition',
  general:       'well-composed scene, balanced layout, professional quality',
};

// ─── Style quality boosters ───────────────────────────────────────────────────

const STYLE_BOOSTERS: Record<string, string> = {
  elegant:        'elegant, sophisticated, luxury aesthetic, refined details, premium quality',
  minimalist:     'minimalist design, clean lines, ample white space, simple yet impactful',
  vibrant:        'vibrant colors, high saturation, energetic composition, eye-catching',
  anime:          'anime art style, clean cel-shading, expressive characters, Japanese animation aesthetic',
  photorealistic: 'photorealistic, ultra-detailed, 8K resolution, professional photography quality',
  watercolor:     'watercolor painting style, soft washes, artistic brushwork, delicate textures',
  vintage:        'vintage aesthetic, retro color grading, nostalgic feel, aged texture',
  modern:         'modern design, contemporary aesthetic, sleek and clean, current trends',
  cute:           'cute and adorable style, soft colors, friendly characters, kawaii aesthetic',
  dark:           'dark and moody atmosphere, dramatic lighting, deep shadows, cinematic',
  floral:         'floral elements, botanical details, natural beauty, garden-inspired',
  '3d':           '3D rendered, volumetric lighting, realistic materials, depth and dimension',
};

// ─── Quality suffix ───────────────────────────────────────────────────────────

const QUALITY_SUFFIX = 'high resolution, professional quality, detailed, sharp focus, beautiful composition';

const NEGATIVE_PROMPT = 'blurry, low quality, pixelated, distorted, ugly, deformed, watermark, text errors, bad typography, amateur, low resolution, oversaturated, washed out';

// ─── Text overlay builder ─────────────────────────────────────────────────────

function buildTextOverlay(classification: ImageClassification): string {
  const { occasion, names, category } = classification;

  if (!classification.isTextDesign) return '';

  const parts: string[] = [];

  // Occasion text
  const occasionText: Partial<Record<OccasionType, string>> = {
    anniversary:     'Happy Marriage Anniversary',
    birthday:        'Happy Birthday',
    wedding:         'Congratulations on Your Wedding',
    graduation:      'Congratulations Graduate',
    new_year:        'Happy New Year',
    diwali:          'Happy Diwali',
    eid:             'Eid Mubarak',
    christmas:       'Merry Christmas',
    holi:            'Happy Holi',
    farewell:        'Farewell and Best Wishes',
    congratulations: 'Congratulations',
    get_well:        'Get Well Soon',
    thank_you:       'Thank You',
  };

  const mainText = occasionText[occasion];
  if (mainText) {
    const nameStr = names.length > 0 ? ` ${names.join(' & ')}` : '';
    parts.push(`bold decorative text reads "${mainText}${nameStr}"`);
  } else if (names.length > 0) {
    parts.push(`personalized text featuring the name "${names.join(' & ')}"`);
  }

  if (category === 'poster' || category === 'banner') {
    parts.push('elegant typography, readable font, decorative text styling');
  }

  return parts.join(', ');
}

// ─── Color palette builder ────────────────────────────────────────────────────

function buildColorPalette(classification: ImageClassification): string {
  const { colorHints, occasion, category } = classification;

  // User-specified colors take priority
  if (colorHints.length > 0) {
    return `${colorHints.join(' and ')} color palette`;
  }

  // Occasion-based defaults
  const occasionColors: Partial<Record<OccasionType, string>> = {
    anniversary:     'rich gold and deep red color palette, romantic warm tones',
    birthday:        'bright and cheerful multicolor palette, festive colors',
    wedding:         'white, ivory and gold color palette, elegant and pure',
    graduation:      'navy blue and gold color palette, academic prestige',
    new_year:        'gold, silver and midnight blue color palette',
    diwali:          'warm orange, gold and red color palette, festive Indian colors',
    eid:             'emerald green and gold color palette, Islamic aesthetic',
    christmas:       'red, green and gold color palette, traditional Christmas',
    holi:            'rainbow multicolor palette, vibrant festival colors',
    farewell:        'warm sunset orange and golden color palette',
    congratulations: 'gold and royal blue color palette, achievement colors',
    get_well:        'soft pastel green and yellow color palette, healing and hopeful',
    thank_you:       'warm peach and gold color palette, gratitude tones',
  };

  return occasionColors[occasion] ?? 'harmonious color palette, balanced tones';
}

// ─── Main prompt engineer ─────────────────────────────────────────────────────

export function engineerImagePrompt(userPrompt: string): EngineeredPrompt {
  const classification = classifyImageRequest(userPrompt);
  const { category, occasion, names, styleHints, cleanSubject } = classification;

  const parts: string[] = [];

  // 1. Opening — what kind of image
  const categoryLabel: Record<ImageCategory, string> = {
    poster:        'A stunning, professionally designed poster',
    greeting_card: 'A beautiful, heartfelt greeting card',
    wallpaper:     'A breathtaking wallpaper',
    portrait:      'A detailed, expressive portrait',
    landscape:     'A magnificent landscape scene',
    logo:          'A clean, professional logo design',
    banner:        'A striking banner design',
    illustration:  'A detailed, artistic illustration',
    meme:          'A clear, well-composed image',
    general:       'A beautiful, detailed image',
  };
  parts.push(categoryLabel[category]);

  // 2. Subject / occasion context
  if (occasion !== 'none') {
    const occasionLabel: Partial<Record<OccasionType, string>> = {
      anniversary:     'celebrating a marriage anniversary',
      birthday:        'celebrating a birthday',
      wedding:         'celebrating a wedding',
      graduation:      'celebrating graduation',
      new_year:        'welcoming the New Year',
      diwali:          'celebrating Diwali',
      eid:             'celebrating Eid',
      christmas:       'celebrating Christmas',
      holi:            'celebrating Holi',
      farewell:        'marking a farewell',
      congratulations: 'celebrating an achievement',
      get_well:        'wishing a speedy recovery',
      thank_you:       'expressing gratitude',
    };
    parts.push(occasionLabel[occasion] ?? '');
  } else if (cleanSubject) {
    parts.push(`featuring ${cleanSubject}`);
  }

  // 3. Names / personalization
  if (names.length > 0 && classification.isTextDesign) {
    parts.push(`personalized for ${names.join(' and ')}`);
  }

  // 4. Occasion-specific visual elements
  const occasionVisuals = OCCASION_VISUALS[occasion];
  if (occasionVisuals) {
    parts.push(occasionVisuals);
  }

  // 5. Text overlay (for posters, cards, banners)
  const textOverlay = buildTextOverlay(classification);
  if (textOverlay) {
    parts.push(textOverlay);
  }

  // 6. Color palette
  parts.push(buildColorPalette(classification));

  // 7. Composition rules
  parts.push(CATEGORY_COMPOSITION[category]);

  // 8. Style boosters
  for (const style of styleHints) {
    const booster = STYLE_BOOSTERS[style];
    if (booster) parts.push(booster);
  }

  // 9. Default style if none specified
  if (styleHints.length === 0) {
    if (occasion !== 'none') parts.push('elegant and celebratory aesthetic');
    else parts.push('visually appealing, artistic composition');
  }

  // 10. Quality suffix
  parts.push(QUALITY_SUFFIX);

  // Build final prompt — filter empty strings, join with '. '
  const positive = parts
    .filter(p => p.trim().length > 0)
    .join('. ')
    .replace(/\.\s*\./g, '.')
    .trim();

  return {
    positive,
    negative: NEGATIVE_PROMPT,
    aspectRatio: classification.aspectRatio,
    classification,
  };
}

/**
 * Quick helper — returns just the positive prompt string.
 */
export function buildImagePrompt(userPrompt: string): string {
  return engineerImagePrompt(userPrompt).positive;
}
