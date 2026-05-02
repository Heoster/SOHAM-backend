import { formatResultsForAI, searchDuckDuckGo } from './duckduckgo';

export type SohamToolName =
  | 'news_search'
  | 'weather_search'
  | 'sports_search'
  | 'finance_search'
  | 'web_search'
  | 'translate'
  | 'sentiment'
  | 'grammar'
  | 'quiz'
  | 'recipe'
  | 'joke'
  | 'dictionary'
  | 'fact_check';

export interface SohamToolResult {
  tool: SohamToolName;
  query: string;
  ok: boolean;
  output: string;
  sources?: Array<{ title: string; url: string }>;
}

interface ToolIntent {
  tool: SohamToolName;
  query: string;
}

function sanitizeQuery(query: string): string {
  return query
    .replace(/[^\w\s\-.,/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function extractCommandQuery(message: string): { command?: string; query?: string } {
  const match = message.trim().match(/^\/([a-z_]+)\s+(.+)$/i);
  if (!match) return {};
  return { command: match[1].toLowerCase(), query: sanitizeQuery(match[2]) };
}

export function detectToolIntent(message: string): ToolIntent | null {
  const normalized = message.trim();
  const lower = normalized.toLowerCase();
  const { command, query } = extractCommandQuery(normalized);

  if (command && query) {
    if (['news', 'news_search', 'ews_search'].includes(command)) {
      return { tool: 'news_search', query };
    }
    if (['weather', 'weather_search'].includes(command)) {
      return { tool: 'weather_search', query };
    }
    if (['sports', 'sports_search'].includes(command)) {
      return { tool: 'sports_search', query };
    }
    if (['finance', 'finance_search'].includes(command)) {
      return { tool: 'finance_search', query };
    }
    if (['search', 'web_search', 'research'].includes(command)) {
      return { tool: 'web_search', query };
    }
    if (['translate', 'translation'].includes(command)) {
      return { tool: 'translate', query };
    }
    if (['sentiment', 'analyze', 'emotion'].includes(command)) {
      return { tool: 'sentiment', query };
    }
    if (['grammar', 'correct', 'proofread'].includes(command)) {
      return { tool: 'grammar', query };
    }
    if (['quiz', 'flashcard', 'test'].includes(command)) {
      return { tool: 'quiz', query };
    }
    if (['recipe', 'cook', 'food'].includes(command)) {
      return { tool: 'recipe', query };
    }
    if (['joke', 'pun', 'roast', 'riddle', 'funny'].includes(command)) {
      return { tool: 'joke', query };
    }
    if (['define', 'dictionary', 'word', 'meaning'].includes(command)) {
      return { tool: 'dictionary', query };
    }
    if (['factcheck', 'fact_check', 'verify', 'check'].includes(command)) {
      return { tool: 'fact_check', query };
    }
  }

  if (/\b(weather|temperature|forecast|rain|humidity)\b/i.test(lower)) {
    return { tool: 'weather_search', query: sanitizeQuery(normalized) };
  }
  if (/\b(cricket|match|matches|score|live score|ipl|sports)\b/i.test(lower)) {
    return { tool: 'sports_search', query: sanitizeQuery(normalized) };
  }
  if (/\b(stock|stocks|crypto|bitcoin|btc|ethereum|eth|price of|market cap|nifty|sensex)\b/i.test(lower)) {
    return { tool: 'finance_search', query: sanitizeQuery(normalized) };
  }
  if (/\b(news|headlines|latest updates|breaking)\b/i.test(lower)) {
    return { tool: 'news_search', query: sanitizeQuery(normalized) };
  }
  if (
    /\b(current|latest|today|live|recent)\b/i.test(lower) ||
    /\b(vice president of|prime minister of|president of|ceo of|founder of|governor of|population of|capital of|currency of)\b/i.test(lower) ||
    /^(who|what|where|when)\s+(is|are|was|were|did|does|do)\b/i.test(lower)
  ) {
    return { tool: 'web_search', query: sanitizeQuery(normalized) };
  }
  if (/\b(search|look up|find on web|web search|research)\b/i.test(lower)) {
    return { tool: 'web_search', query: sanitizeQuery(normalized) };
  }
  // Translate
  if (/\b(translate|translation|in (spanish|french|hindi|german|japanese|chinese|arabic|portuguese|russian|korean|italian|turkish|dutch|polish|swedish|norwegian|danish|finnish|greek|hebrew|thai|vietnamese|indonesian|malay|bengali|urdu|tamil|telugu|marathi|gujarati|punjabi|kannada|malayalam))\b/i.test(lower)) {
    return { tool: 'translate', query: sanitizeQuery(normalized) };
  }
  // Sentiment
  if (/\b(sentiment|emotion|tone|feeling|mood|analyze (this|the|my) (text|message|review|comment))\b/i.test(lower)) {
    return { tool: 'sentiment', query: sanitizeQuery(normalized) };
  }
  // Grammar
  if (/\b(grammar|proofread|correct (my|this|the) (text|writing|essay|email|message)|fix (my|this|the) (grammar|spelling|writing))\b/i.test(lower)) {
    return { tool: 'grammar', query: sanitizeQuery(normalized) };
  }
  // Quiz
  if (/\b(quiz|flashcard|make (a|some) (quiz|questions|flashcards)|test me on|study (guide|material))\b/i.test(lower)) {
    return { tool: 'quiz', query: sanitizeQuery(normalized) };
  }
  // Recipe
  if (/\b(recipe|how (to|do i) (cook|make|bake|prepare)|ingredients for|dish|meal|food idea)\b/i.test(lower)) {
    return { tool: 'recipe', query: sanitizeQuery(normalized) };
  }
  // Joke
  if (/\b(tell (me )?(a )?(joke|pun|riddle|fun fact)|make me laugh|roast me|give me a (joke|pun|riddle))\b/i.test(lower)) {
    return { tool: 'joke', query: sanitizeQuery(normalized) };
  }
  // Dictionary
  if (/\b(define|definition of|what does .+ mean|meaning of|synonym(s)? (of|for)|antonym(s)? (of|for)|etymology of)\b/i.test(lower)) {
    return { tool: 'dictionary', query: sanitizeQuery(normalized) };
  }
  // Fact check
  if (/\b(fact.?check|is it true (that)?|verify (that|this|the claim)|debunk|myth or fact|true or false)\b/i.test(lower)) {
    return { tool: 'fact_check', query: sanitizeQuery(normalized) };
  }

  return null;
}

async function fetchJson<T>(url: string, timeoutMs = 5000): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseLocation(query: string): string {
  const inMatch = query.match(/\bin\s+([a-zA-Z\s,.-]+)$/i);
  return sanitizeQuery(inMatch?.[1] || query) || 'New York';
}

async function weatherSearch(query: string): Promise<SohamToolResult> {
  const location = parseLocation(query);
  try {
    const geo = await fetchJson<{ results?: Array<{ latitude: number; longitude: number; name: string; country?: string }> }>(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`
    );
    const place = geo.results?.[0];
    if (!place) {
      return { tool: 'weather_search', query, ok: false, output: `No weather location found for "${location}".` };
    }

    const weather = await fetchJson<{
      current?: { temperature_2m?: number; wind_speed_10m?: number; weather_code?: number; time?: string };
    }>(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,wind_speed_10m,weather_code&timezone=auto`
    );

    const current = weather.current;
    if (!current) {
      return { tool: 'weather_search', query, ok: false, output: `Weather data is unavailable for ${place.name}.` };
    }

    return {
      tool: 'weather_search',
      query,
      ok: true,
      output:
        `Current weather for ${place.name}${place.country ? `, ${place.country}` : ''}: ` +
        `${current.temperature_2m ?? 'N/A'}°C, wind ${current.wind_speed_10m ?? 'N/A'} km/h, ` +
        `code ${current.weather_code ?? 'N/A'} (time: ${current.time ?? 'N/A'}).`,
    };
  } catch (error) {
    return { tool: 'weather_search', query, ok: false, output: `Weather lookup failed: ${String(error)}` };
  }
}

async function newsSearch(query: string): Promise<SohamToolResult> {
  const safeQuery = sanitizeQuery(query) || 'latest technology news';
  const apiKey = process.env.GNEWS_API_KEY;

  if (!apiKey) {
    return {
      tool: 'news_search',
      query: safeQuery,
      ok: false,
      output: 'GNews API key is not configured (GNEWS_API_KEY).',
    };
  }

  try {
    const data = await fetchJson<{
      articles?: Array<{ title: string; url: string; description?: string; publishedAt?: string; source?: { name?: string } }>;
    }>(
      `https://gnews.io/api/v4/search?q=${encodeURIComponent(safeQuery)}&lang=en&max=5&apikey=${encodeURIComponent(apiKey)}`
    );

    const articles = data.articles || [];
    if (articles.length === 0) {
      return { tool: 'news_search', query: safeQuery, ok: true, output: 'No recent news articles found.' };
    }

    const output = articles
      .map((a, i) => `${i + 1}. ${a.title} (${a.source?.name || 'Unknown source'}, ${a.publishedAt || 'N/A'})`)
      .join('\n');

    return {
      tool: 'news_search',
      query: safeQuery,
      ok: true,
      output,
      sources: articles.map(a => ({ title: a.title, url: a.url })),
    };
  } catch (error) {
    return { tool: 'news_search', query: safeQuery, ok: false, output: `News lookup failed: ${String(error)}` };
  }
}

async function sportsSearch(query: string): Promise<SohamToolResult> {
  const safeQuery = sanitizeQuery(query) || 'live cricket matches';
  const cricApiKey = process.env.CRICAPI_KEY;

  try {
    if (cricApiKey) {
      const data = await fetchJson<{ data?: Array<{ name?: string; status?: string; venue?: string; dateTimeGMT?: string }> }>(
        `https://api.cricapi.com/v1/currentMatches?apikey=${encodeURIComponent(cricApiKey)}&offset=0`
      );
      const matches = (data.data || []).slice(0, 8);
      if (matches.length === 0) {
        return { tool: 'sports_search', query: safeQuery, ok: true, output: 'No live cricket matches returned by CricAPI.' };
      }
      const lines = matches.map((m, i) => `${i + 1}. ${m.name || 'Match'} - ${m.status || 'Status unavailable'} (${m.venue || 'Unknown venue'})`);
      return { tool: 'sports_search', query: safeQuery, ok: true, output: lines.join('\n') };
    }

    // Free fallback: web search for live cricket updates
    const duck = await searchDuckDuckGo(`live cricket matches ${safeQuery}`);
    const top = duck.results.slice(0, 5);
    if (top.length === 0) {
      return { tool: 'sports_search', query: safeQuery, ok: false, output: 'No sports results found. Configure CRICAPI_KEY for direct live match feeds.' };
    }
    return {
      tool: 'sports_search',
      query: safeQuery,
      ok: true,
      output: top.map((r, i) => `${i + 1}. ${r.title} - ${r.snippet}`).join('\n'),
      sources: top.map(r => ({ title: r.title, url: r.url })),
    };
  } catch (error) {
    return { tool: 'sports_search', query: safeQuery, ok: false, output: `Sports lookup failed: ${String(error)}` };
  }
}

async function financeSearch(query: string): Promise<SohamToolResult> {
  const safeQuery = sanitizeQuery(query);
  const lower = safeQuery.toLowerCase();
  const alphaVantageKey = process.env.ALPHA_VANTAGE_API_KEY;

  // ── Detect requested fiat currency ────────────────────────────────────────
  const wantsINR = /\binr\b|rupee|rupees|indian/i.test(lower);
  const wantsEUR = /\beur\b|euro/i.test(lower);
  const wantsGBP = /\bgbp\b|pound/i.test(lower);
  const fiatCurrency = wantsINR ? 'inr' : wantsEUR ? 'eur' : wantsGBP ? 'gbp' : 'usd';
  const fiatSymbol   = wantsINR ? '₹' : wantsEUR ? '€' : wantsGBP ? '£' : '$';

  // ── Crypto map ────────────────────────────────────────────────────────────
  const cryptoMap: Record<string, string> = {
    bitcoin: 'bitcoin', btc: 'bitcoin',
    ethereum: 'ethereum', eth: 'ethereum',
    solana: 'solana', sol: 'solana',
    dogecoin: 'dogecoin', doge: 'dogecoin',
    ripple: 'ripple', xrp: 'ripple',
    cardano: 'cardano', ada: 'cardano',
    bnb: 'binancecoin',
    usdt: 'tether', tether: 'tether',
  };

  const cryptoId = Object.entries(cryptoMap).find(([k]) => lower.includes(k))?.[1];

  if (cryptoId) {
    // ── Source 1: CoinGecko — supports INR/EUR/GBP natively ─────────────────
    try {
      const data = await fetchJson<Record<string, Record<string, number>>>(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(cryptoId)}&vs_currencies=${fiatCurrency},usd&include_24hr_change=true`,
        6000
      );
      const quote = data[cryptoId];
      if (quote) {
        const price    = quote[fiatCurrency] ?? quote['usd'];
        const change   = (quote as any)[`${fiatCurrency}_24h_change`] ?? (quote as any)['usd_24h_change'];
        const sym      = quote[fiatCurrency] != null ? fiatSymbol : '$';
        const cur      = quote[fiatCurrency] != null ? fiatCurrency.toUpperCase() : 'USD';
        const formatted = price >= 1000
          ? price.toLocaleString('en-IN', { maximumFractionDigits: 0 })
          : price.toFixed(4);
        return {
          tool: 'finance_search', query: safeQuery, ok: true,
          output: `**${cryptoId.toUpperCase()} / ${cur}**: ${sym}${formatted}` +
            (change != null ? `  (24h: ${change >= 0 ? '+' : ''}${(change as number).toFixed(2)}%)` : '') +
            `\nSource: CoinGecko · ${new Date().toUTCString()}`,
        };
      }
    } catch (cgErr) {
      console.warn('[Finance] CoinGecko failed:', String(cgErr).slice(0, 80));
    }

    // ── Source 2: Binance REST (free, no key, high rate limit) ───────────────
    const binanceMap: Record<string, string> = {
      bitcoin: 'BTCUSDT', ethereum: 'ETHUSDT', solana: 'SOLUSDT',
      dogecoin: 'DOGEUSDT', ripple: 'XRPUSDT', cardano: 'ADAUSDT',
      binancecoin: 'BNBUSDT',
    };
    const binancePair = binanceMap[cryptoId];
    if (binancePair) {
      try {
        const ticker = await fetchJson<{ price?: string }>(
          `https://api.binance.com/api/v3/ticker/price?symbol=${binancePair}`,
          5000
        );
        const usdPrice = parseFloat(ticker.price ?? '0');
        if (usdPrice > 0) {
          let finalPrice = usdPrice;
          let finalSym = '$';
          let finalCur = 'USD';

          if (fiatCurrency !== 'usd') {
            try {
              const fx = await fetchJson<{ rates?: Record<string, number> }>(
                `https://open.er-api.com/v6/latest/USD`,
                5000
              );
              const rate = fx.rates?.[fiatCurrency.toUpperCase()];
              if (rate) {
                finalPrice = usdPrice * rate;
                finalSym = fiatSymbol;
                finalCur = fiatCurrency.toUpperCase();
              }
            } catch { /* keep USD */ }
          }

          const formatted = finalPrice >= 1000
            ? finalPrice.toLocaleString('en-IN', { maximumFractionDigits: 0 })
            : finalPrice.toFixed(4);

          return {
            tool: 'finance_search', query: safeQuery, ok: true,
            output: `**${cryptoId.toUpperCase()} / ${finalCur}**: ${finalSym}${formatted}` +
              `\nSource: Binance · ${new Date().toUTCString()}`,
          };
        }
      } catch (binErr) {
        console.warn('[Finance] Binance failed:', String(binErr).slice(0, 80));
      }
    }

    // ── Source 3: Tavily web search fallback ──────────────────────────────────
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (tavilyKey) {
      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: tavilyKey,
            query: `${cryptoId} price in ${fiatCurrency.toUpperCase()} today live`,
            search_depth: 'basic', max_results: 3, include_answer: true,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          if (data.answer) {
            return {
              tool: 'finance_search', query: safeQuery, ok: true,
              output: `${cryptoId.toUpperCase()} price (web search): ${data.answer}\n⚠ Web search result — verify at coingecko.com`,
            };
          }
        }
      } catch { /* fall through */ }
    }

    // All sources failed — honest error, no hallucination
    return {
      tool: 'finance_search', query: safeQuery, ok: false,
      output: `Unable to fetch live ${cryptoId.toUpperCase()} price right now — all sources are temporarily unavailable. Check https://coingecko.com or https://coinmarketcap.com for the latest price.`,
    };
  }

  // ── Stock path (Alpha Vantage — with fiat conversion) ───────────────────
  const symbolMatch = safeQuery.toUpperCase().match(/\b[A-Z]{1,5}\b/);
  if (symbolMatch && alphaVantageKey) {
    const symbol = symbolMatch[0];
    try {
      const data = await fetchJson<Record<string, Record<string, string>>>(
        `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(alphaVantageKey)}`,
        8000
      );
      const quote = data['Global Quote'] || {};
      const priceUSD = parseFloat(quote['05. price'] ?? '0');
      const change   = quote['10. change percent'] ?? 'N/A';
      if (!priceUSD) {
        return { tool: 'finance_search', query: safeQuery, ok: false, output: `No stock quote found for ${symbol}.` };
      }
      let displayPrice = `$${priceUSD.toFixed(2)}`;
      if (fiatCurrency !== 'usd') {
        try {
          const fx = await fetchJson<{ 'Realtime Currency Exchange Rate'?: Record<string, string> }>(
            `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=USD&to_currency=${fiatCurrency.toUpperCase()}&apikey=${encodeURIComponent(alphaVantageKey)}`,
            6000
          );
          const rate = parseFloat(fx['Realtime Currency Exchange Rate']?.['5. Exchange Rate'] ?? '0');
          if (rate > 0) {
            const converted = priceUSD * rate;
            const formatted = converted >= 100
              ? converted.toLocaleString('en-IN', { maximumFractionDigits: 2 })
              : converted.toFixed(4);
            displayPrice = `${fiatSymbol}${formatted} (${fiatCurrency.toUpperCase()})`;
          }
        } catch { /* keep USD */ }
      }
      return {
        tool: 'finance_search', query: safeQuery, ok: true,
        output: `**${symbol}**: ${displayPrice}  (change: ${change})\nSource: Alpha Vantage`,
      };
    } catch (error) {
      return { tool: 'finance_search', query: safeQuery, ok: false, output: `Stock lookup failed: ${String(error)}` };
    }
  }
  // ── Fallback to web search ────────────────────────────────────────────────
  try {
    const duck = await searchDuckDuckGo(`finance market ${safeQuery}`);
    const top = duck.results.slice(0, 4);
    return {
      tool: 'finance_search', query: safeQuery,
      ok: top.length > 0,
      output: top.length ? top.map((r, i) => `${i + 1}. ${r.title} - ${r.snippet}`).join('\n') : 'No finance results found.',
      sources: top.filter(r => r.title && r.url).map(r => ({ title: r.title!, url: r.url! })),
    };
  } catch (error) {
    return { tool: 'finance_search', query: safeQuery, ok: false, output: `Finance lookup failed: ${String(error)}` };
  }
}

async function webSearch(query: string): Promise<SohamToolResult> {
  const safeQuery = sanitizeQuery(query);
  try {
    // Use the full search pipeline (Tavily → Wikipedia → DuckDuckGo fallback)
    const { runSearchPipeline } = await import('./search-engine');
    const result = await runSearchPipeline(safeQuery);
    const top = result.results.slice(0, 5);

    if (top.length === 0) {
      return { tool: 'web_search', query: safeQuery, ok: false, output: 'No web search results found.' };
    }

    const output = top
      .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.snippet}\n   ${r.url}`)
      .join('\n\n');

    return {
      tool: 'web_search',
      query: safeQuery,
      ok: true,
      output,
      sources: top.map(r => ({ title: r.title, url: r.url })),
    };
  } catch (error) {
    // Fallback to DuckDuckGo if pipeline fails
    try {
      const duck = await searchDuckDuckGo(safeQuery);
      const top = duck.results.slice(0, 5);
      return {
        tool: 'web_search',
        query: safeQuery,
        ok: top.length > 0,
        output: top.length > 0 ? formatResultsForAI({ query: safeQuery, results: top }) : 'No web search results found.',
        sources: top.map(r => ({ title: r.title, url: r.url })),
      };
    } catch {
      return { tool: 'web_search', query: safeQuery, ok: false, output: `Web search failed: ${String(error)}` };
    }
  }
}

export async function executeSohamTool(message: string): Promise<SohamToolResult | null> {
  const intent = detectToolIntent(message);
  if (!intent) return null;

  switch (intent.tool) {
    case 'news_search':
      return newsSearch(intent.query);
    case 'weather_search':
      return weatherSearch(intent.query);
    case 'sports_search':
      return sportsSearch(intent.query);
    case 'finance_search':
      return financeSearch(intent.query);
    case 'web_search':
      return webSearch(intent.query);
    case 'translate':
      return translateTool(intent.query);
    case 'sentiment':
      return sentimentTool(intent.query);
    case 'grammar':
      return grammarTool(intent.query);
    case 'quiz':
      return quizTool(intent.query);
    case 'recipe':
      return recipeTool(intent.query);
    case 'joke':
      return jokeTool(intent.query);
    case 'dictionary':
      return dictionaryTool(intent.query);
    case 'fact_check':
      return factCheckTool(intent.query);
    default:
      return null;
  }
}

// ─── New Skill Tool Wrappers ──────────────────────────────────────────────────
// These call the flow functions directly (no HTTP round-trip needed in server context)

async function translateTool(query: string): Promise<SohamToolResult> {
  try {
    const { enhancedTranslate } = await import('../flows/enhanced-translate');
    // Extract target language from query (e.g. "translate hello to Spanish")
    const toLangMatch = query.match(/\bto\s+([a-zA-Z]+)\b/i);
    const targetLanguage = toLangMatch?.[1] || 'English';
    const textToTranslate = query.replace(/translate\s+/i, '').replace(/\s+to\s+[a-zA-Z]+$/i, '').trim() || query;
    const result = await enhancedTranslate({
      text: textToTranslate,
      targetLanguage,
      sourceLanguage: 'auto',
      tone: 'neutral',
    });
    return {
      tool: 'translate',
      query,
      ok: true,
      output: `Translation to ${result.targetLanguage}: "${result.translatedText}" (from ${result.detectedSourceLanguage}, confidence: ${result.confidence})`,
    };
  } catch (error) {
    return { tool: 'translate', query, ok: false, output: `Translation failed: ${String(error)}` };
  }
}

async function sentimentTool(query: string): Promise<SohamToolResult> {
  try {
    const { enhancedSentiment } = await import('../flows/enhanced-sentiment');
    const result = await enhancedSentiment({ text: query, detailed: false });
    const emotions = result.emotions.slice(0, 3).map(e => `${e.emotion} (${(e.intensity * 100).toFixed(0)}%)`).join(', ');
    return {
      tool: 'sentiment',
      query,
      ok: true,
      output: `Sentiment: ${result.sentiment} (score: ${result.score.toFixed(2)}, confidence: ${(result.confidence * 100).toFixed(0)}%)\nTone: ${result.tone} | Intent: ${result.intent}\nEmotions: ${emotions}\n${result.summary}`,
    };
  } catch (error) {
    return { tool: 'sentiment', query, ok: false, output: `Sentiment analysis failed: ${String(error)}` };
  }
}

async function grammarTool(query: string): Promise<SohamToolResult> {
  try {
    const { enhancedGrammar } = await import('../flows/enhanced-grammar');
    const result = await enhancedGrammar({
      text: query,
      mode: 'both',
      targetAudience: 'general',
    });
    const changesCount = result.changes.length;
    return {
      tool: 'grammar',
      query,
      ok: true,
      output: `Corrected text: "${result.correctedText}"\n\nScore: ${result.overallScore}/100 | Readability: ${result.readabilityScore}\nChanges made: ${changesCount}\n${result.summary}`,
    };
  } catch (error) {
    return { tool: 'grammar', query, ok: false, output: `Grammar check failed: ${String(error)}` };
  }
}

async function quizTool(query: string): Promise<SohamToolResult> {
  try {
    const { enhancedQuiz } = await import('../flows/enhanced-quiz');
    const result = await enhancedQuiz({
      topic: query,
      questionCount: 3,
      difficulty: 'medium',
      type: 'mcq',
    });
    const preview = result.questions.slice(0, 2).map((q, i) => `Q${i + 1}: ${q.question}`).join('\n');
    return {
      tool: 'quiz',
      query,
      ok: true,
      output: `Quiz: "${result.title}" (${result.totalQuestions} questions, ~${result.estimatedTime})\n\nPreview:\n${preview}\n\nUse /api/ai/quiz for the full quiz with answers.`,
    };
  } catch (error) {
    return { tool: 'quiz', query, ok: false, output: `Quiz generation failed: ${String(error)}` };
  }
}

async function recipeTool(query: string): Promise<SohamToolResult> {
  try {
    const { enhancedRecipe } = await import('../flows/enhanced-recipe');
    const result = await enhancedRecipe({
      query,
      ingredients: [],
      dietary: [],
      servings: 4,
      difficulty: 'any',
    });
    const ingredientCount = result.ingredients.length;
    const stepCount = result.instructions.length;
    return {
      tool: 'recipe',
      query,
      ok: true,
      output: `Recipe: ${result.name}\n${result.description}\n\nCuisine: ${result.cuisine} | Difficulty: ${result.difficulty}\nTime: ${result.totalTime} | Servings: ${result.servings} | Calories: ${result.calories}\nIngredients: ${ingredientCount} items | Steps: ${stepCount}\n\nUse /api/ai/recipe for the full recipe with all steps.`,
    };
  } catch (error) {
    return { tool: 'recipe', query, ok: false, output: `Recipe generation failed: ${String(error)}` };
  }
}

async function jokeTool(query: string): Promise<SohamToolResult> {
  try {
    const { enhancedJoke } = await import('../flows/enhanced-joke');
    const result = await enhancedJoke({
      topic: query,
      count: 1,
      type: 'joke',
      style: 'witty',
    });
    const item = result.items[0];
    const output = item.punchline
      ? `${item.content}\n\n${item.punchline}`
      : item.answer
        ? `${item.content}\n\nAnswer: ${item.answer}`
        : item.content;
    return { tool: 'joke', query, ok: true, output };
  } catch (error) {
    return { tool: 'joke', query, ok: false, output: `Joke generation failed: ${String(error)}` };
  }
}

async function dictionaryTool(query: string): Promise<SohamToolResult> {
  try {
    const { enhancedDictionary } = await import('../flows/enhanced-dictionary');
    // Extract the word from the query
    const wordMatch = query.match(/\b(?:define|definition of|meaning of|what does|synonym(?:s)? (?:of|for)|antonym(?:s)? (?:of|for)|etymology of)\s+([a-zA-Z'-]+)/i);
    const word = wordMatch?.[1] || query.split(/\s+/)[0];
    const result = await enhancedDictionary({
      word,
      language: 'English',
      includeEtymology: true,
    });
    const primaryDef = result.definitions[0];
    const synonyms = result.synonyms.slice(0, 5).join(', ');
    return {
      tool: 'dictionary',
      query,
      ok: true,
      output: `${result.word} [${result.pronunciation}] (${result.partOfSpeech.join(', ')})\n\n${primaryDef?.definition || 'No definition found.'}\nExample: "${primaryDef?.example || 'N/A'}"\n\nSynonyms: ${synonyms || 'None'}\n${result.etymology ? `Etymology: ${result.etymology}` : ''}`,
    };
  } catch (error) {
    return { tool: 'dictionary', query, ok: false, output: `Dictionary lookup failed: ${String(error)}` };
  }
}

async function factCheckTool(query: string): Promise<SohamToolResult> {
  try {
    const { enhancedFactCheck } = await import('../flows/enhanced-fact-check');
    const result = await enhancedFactCheck({ claim: query });
    const verdictEmoji: Record<string, string> = {
      true: '✅', false: '❌', mostly_true: '🟡', mostly_false: '🟠', unverifiable: '❓', misleading: '⚠️',
    };
    const emoji = verdictEmoji[result.verdict] || '❓';
    return {
      tool: 'fact_check',
      query,
      ok: true,
      output: `${emoji} Verdict: ${result.verdict.replace('_', ' ').toUpperCase()} (confidence: ${(result.confidence * 100).toFixed(0)}%)\n\n${result.explanation}\n\nNuance: ${result.nuance}`,
      sources: result.sources.map((s): { title: string; url: string } => ({ title: s.title, url: s.url })),
    };
  } catch (error) {
    return { tool: 'fact_check', query, ok: false, output: `Fact check failed: ${String(error)}` };
  }
}
