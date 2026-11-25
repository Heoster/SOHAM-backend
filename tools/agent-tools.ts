import { weatherSearch, sportsSearch } from './live-data';
import { resolveDataFollowup } from '../utils/followup-context';
import { formatResultsForAI, searchDuckDuckGo } from './duckduckgo';
import { extractPlayQuery, resolveReferencedQuery, type ConversationTurnLike } from './youtube-play';
export type { ConversationTurnLike };
import { stripInjectedContext } from '../utils/clean-message';

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
  | 'fact_check'
  | 'play_video'
  | 'web_read'
  | 'wikipedia'
  | 'chart'
  | 'image_generate'
  | 'summarize';

export interface SohamToolResult {
  tool: SohamToolName;
  query: string;
  ok: boolean;
  output: string;
  sources?: Array<{ title: string; url: string }>;
  /** URL the client should open (watch URL — or search URL on failure) */
  openUrl?: string;
  /** Iframe-friendly embed URL for the chat page */
  embedUrl?: string;
  /** Structured video payload for a custom player */
  video?: { videoId: string; title: string; channel?: string; thumbnailUrl?: string };
  /** Deterministic SVG chart payload (chart tool / chart short-circuit) */
  chart?: { title: string; tableMarkdown: string; imageDataUri: string; note?: string };
}

interface ToolIntent {
  tool: SohamToolName;
  query: string;
}

function sanitizeQuery(query: string): string {
  return query
    .replace(/\b(?:nvidea|nvdia|nvid[ai]a)\b/gi, 'NVIDIA')
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
  // The frontend appends a SOHAM_CLOCK system block to the user text —
  // strip it so intent detection sees only what the user actually said.
  const normalized = stripInjectedContext(message);
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
    if (['play', 'watch', 'youtube', 'yt', 'video', 'play_video'].includes(command)) {
      return { tool: 'play_video', query };
    }
  }

  // ── Play video / YouTube — "play X", "watch X", "soham play X on youtube" ──
  // Kept ahead of the general search intents and below the sports guard inside
  // extractPlayQuery (sports messages return null there and fall through).
  const playQuery = extractPlayQuery(normalized);
  if (playQuery) {
    return { tool: 'play_video', query: playQuery };
  }

  // ── Image generation — artwork/pictures, high precision ───────────────────
  // The model planner owns this, but when planning is unavailable/weak the
  // regex rollback path must still route "generate an image of …" here instead
  // of letting the chat model answer with an inline SVG.
  if (
    /\b(?:generate|create|draw|make|design|render|paint|sketch|illustrate)\b.{0,48}\b(?:image|picture|photo|illustration|artwork|poster|logo|drawing|painting|avatar|wallpaper|icon)\b/i.test(normalized)
    || /\b(?:image|picture|photo|illustration|artwork|poster|logo|painting|drawing) of\b/i.test(normalized)
  ) {
    return { tool: 'image_generate', query: sanitizeQuery(normalized) };
  }

  // ── Weather — including typos ─────────────────────────────────────────────
  if (/\b(weather|temperature|forecast|rain|humidity|mausam|baarish|tapman|garmi|thand|wether|wheather|forcast|temprature)\b/i.test(lower)) {
    return { tool: 'weather_search', query: normalized.trim().slice(0, 300) };
  }

  // ── Sports ────────────────────────────────────────────────────────────────
  if (/\b(cricket|match|matches|score|live score|ipl|sports|football|soccer|tournament|league)\b/i.test(lower)) {
    return { tool: 'sports_search', query: sanitizeQuery(normalized) };
  }

  // ── Finance — including typos and single-word ─────────────────────────────
  if (/\b(stock|stocks|crypto|bitcoin|btc|ethereum|eth|price of|market cap|nifty|sensex|gold price|silver price|oil price|prise|prce|prcie)\b/i.test(lower) ||
      /^(bitcoin|btc|ethereum|eth|crypto|stocks?|nifty|sensex|gold|silver|oil)$/i.test(lower.trim())) {
    return { tool: 'finance_search', query: sanitizeQuery(normalized) };
  }

  // ── News — explicit keywords + typos ─────────────────────────────────────
  if (/\b(news|headlines|latest updates|breaking|khabar|samachar|taza khabar|newss?|headlins?|breakng)\b/i.test(lower)) {
    return { tool: 'news_search', query: sanitizeQuery(normalized) };
  }

  // ── News — temporal "what happened" patterns (the main gap) ───────────────
  // Catches: "what happened today", "what's going on in the world",
  //          "what happened in the last few hours/days", "recent events",
  //          "anything new", "world events", "global news", etc.
  if (
    /\b(what('?s| is| has)?\s+(happening|going on|new|occurred|happened))\b/i.test(lower) ||
    /\b(happened|happen|happening|occurred|going on|changed?)\b.{0,80}\b(world|today|now|recently|last|past|this week|this month)\b/i.test(lower) ||
    /\b(?:what|any|anything|updates?)\b.{0,80}\b(?:last|past)\s+(?:the\s+)?(?:some\s+|a few\s+|few\s+|couple of\s+|\d+\s+)?(?:hours?|days?|minutes?|weeks?)\b/i.test(lower) ||
    /\b(recent events?|world events?|global events?|current events?|today'?s? events?)\b/i.test(lower) ||
    /\b(anything (new|happening|interesting)|what'?s? new|catch me up|fill me in|update me)\b/i.test(lower) ||
    /\b(world (news|update|situation|today)|global (news|update|situation))\b/i.test(lower) ||
    /\b(duniya mein|aaj kya hua|kya ho raha hai|duniya ka haal|taza khabar|abhi kya chal raha)\b/i.test(lower) ||
    /\b(kya chal raha|kya ho raha|kya hua|kya hoga|kya chalega|kya scene hai|scene kya hai|haal kya hai)\b/i.test(lower) ||
    /\btell me about\b.{0,30}\b(recent|latest|today|current|world|global|breaking)\b.{0,30}\b(events?|news|updates?|happenings?)\b/i.test(lower)
  ) {
    return { tool: 'news_search', query: sanitizeQuery(normalized) || 'world news today' };
  }

  // ── General web search — ONLY explicit search asks or live/current facts ─
  // Do NOT trigger web_search on every "who/what/where/when" or ordinary words
  // like "current" / "today" / "live" (e.g. "what is recursion", "fix my
  // current code"); let the model answer those directly without API cost/latency.
  if (
    /\b(vice president of|prime minister of|president of|ceo of|founder of|governor of|chief minister of|population of|capital of|currency of)\b/i.test(lower) ||
    /\b(latest\s+(?:version|release|news|update|price|model|ios|android|iphone)|current\s+(?:president|prime minister|vp|ceo|price|version|status|rate|value|score|standings|rankings)|right now|as of today|who won|who is leading|release date of)\b/i.test(lower)
  ) {
    return { tool: 'web_search', query: sanitizeQuery(normalized) };
  }
  if (/\b(search(?:\s+the\s+web|\s+online|\s+for)?|look up|find on(?:\s+the)?\s+web|web search|google)\b/i.test(lower)) {
    return { tool: 'web_search', query: sanitizeQuery(normalized) };
  }

  // ── Translate — including typos ───────────────────────────────────────────
  if (/\b(translate|translation|tranlsate|translat|anuvad|in (spanish|french|hindi|german|japanese|chinese|arabic|portuguese|russian|korean|italian|turkish|dutch|polish|swedish|norwegian|danish|finnish|greek|hebrew|thai|vietnamese|indonesian|malay|bengali|urdu|tamil|telugu|marathi|gujarati|punjabi|kannada|malayalam))\b/i.test(lower)) {
    return { tool: 'translate', query: sanitizeQuery(normalized) };
  }
  // ── Sentiment ─────────────────────────────────────────────────────────────
  if (/\b(sentiment|emotion|tone|feeling|mood|analyze (this|the|my) (text|message|review|comment))\b/i.test(lower)) {
    return { tool: 'sentiment', query: sanitizeQuery(normalized) };
  }
  // ── Grammar ───────────────────────────────────────────────────────────────
  if (/\b(grammar|proofread|correct (my|this|the) (text|writing|essay|email|message)|fix (my|this|the) (grammar|spelling|writing))\b/i.test(lower)) {
    return { tool: 'grammar', query: sanitizeQuery(normalized) };
  }
  // ── Quiz ──────────────────────────────────────────────────────────────────
  if (/\b(quiz|flashcard|make (a|some) (quiz|questions|flashcards)|test me on|study (guide|material))\b/i.test(lower)) {
    return { tool: 'quiz', query: sanitizeQuery(normalized) };
  }
  // ── Recipe ────────────────────────────────────────────────────────────────
  if (/\b(recipe|how (to|do i) (cook|make|bake|prepare)|ingredients for|dish|meal|food idea)\b/i.test(lower)) {
    return { tool: 'recipe', query: sanitizeQuery(normalized) };
  }
  // ── Joke — including Hinglish ─────────────────────────────────────────────
  if (/\b(tell (me )?(a )?(joke|pun|riddle|fun fact)|write (me )?(a )?(joke|pun)|give me (a )?(joke|pun|riddle)|make me laugh|roast me|give me a (joke|pun|riddle))\b/i.test(lower) ||
      /\b(sunao|suna|ek joke|ek chutkula|mujhe.*joke|mujhe.*chutkula|mujhe.*hasao|chutkula sunao|joke sunao)\b/i.test(lower)) {
    return { tool: 'joke', query: sanitizeQuery(normalized) };
  }
  // ── Dictionary ────────────────────────────────────────────────────────────
  if (/\b(define|definition of|what does .+ mean|meaning of|synonym(s)? (of|for)|antonym(s)? (of|for)|etymology of)\b/i.test(lower)) {
    return { tool: 'dictionary', query: sanitizeQuery(normalized) };
  }
  // ── Fact check ────────────────────────────────────────────────────────────
  if (/\b(fact.?check|is it true (that)?|verify (that|this|the claim)|debunk|myth or fact|true or false)\b/i.test(lower)) {
    return { tool: 'fact_check', query: sanitizeQuery(normalized) };
  }

  // ── Web read — explicit URL, nothing else claimed the message ──────────────
  // Lowest priority on purpose (specific skills keep their messages; play URLs
  // were handled above). Makes page reading reachable on the planner-free
  // rollback path too (SOHAM_AGENT_DISABLED=1).
  const urlMatch = normalized.match(/https?:\/\/[^\s)<>\]]+/i);
  if (urlMatch) {
    return { tool: 'web_read', query: urlMatch[0] };
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

async function newsSearch(query: string): Promise<SohamToolResult> {
  const safeQuery = sanitizeQuery(query) || 'latest news';
  try {
    // Use the same source fan-out as web search (Tavily/You.com/Jina/Firecrawl/
    // GNews/Google News RSS/DuckDuckGo), not a separate single-provider path.
    const { runSearchPipeline } = await import('./search-engine');
    const result = await runSearchPipeline(safeQuery);
    const articles = result.results.slice(0, 6);
    return {
      tool: 'news_search',
      query: safeQuery,
      ok: articles.length > 0,
      output: articles.length > 0
        ? articles.map((article, i) =>
            `${i + 1}. ${article.title}${article.publishedAt ? ` (${article.publishedAt})` : ''}: ${article.snippet}\n   Source: ${article.url}`
          ).join('\n')
        : 'No recent news results were returned by the configured search sources.',
      sources: articles.map(article => ({ title: article.title, url: article.url })),
    };
  } catch (error) {
    return { tool: 'news_search', query: safeQuery, ok: false, output: `News search failed: ${String(error)}` };
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

    // Include the full page content of the top results (read via Jina/Firecrawl
    // after the search) — the model should answer from the actual pages, not
    // from snippets alone. Pages read are REAL; cite them with [n].
    const list = top
      .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.snippet}\n   ${r.url}`)
      .join('\n\n');
    const pages = top
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !!r.fullContent)
      .slice(0, 3)
      .map(({ r, i }) => `--- Full page content for [${i + 1}] ${r.title} (${r.url}) ---\n${r.fullContent}`)
      .join('\n\n');
    const output = pages
      ? `${list}\n\nPages read for you (real content of the top results):\n\n${pages}`
      : list;

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

function verifiedLine(title: string | undefined, query: string): string {
  return (
    `Playing: ${title ?? query}\n` +
    '(Resolved live by SOHAM\'s YouTube player just now — the URLs are REAL. ' +
    'Never call them made-up or unverifiable; present the video confidently.)'
  );
}

async function playVideoTool(query: string, history: ConversationTurnLike[] = []): Promise<SohamToolResult> {
  // "play them" / "play it" / "play the second one" → resolve via conversation
  const resolution = resolveReferencedQuery(query, history);

  if (resolution.kind === 'direct') {
    const id = resolution.videoId;
    const watchUrl = `https://www.youtube.com/watch?v=${id}`;
    const embedUrl = `https://www.youtube.com/embed/${id}`;
    // Best-effort REAL metadata (oEmbed, no key) so the player card shows the
    // actual title — falls back gracefully to a labelled placeholder.
    let title = `YouTube video ${id}`;
    let channel: string | undefined;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
        { signal: controller.signal },
      );
      clearTimeout(timer);
      if (res.ok) {
        const meta = await res.json() as { title?: string; author_name?: string };
        if (meta?.title) title = meta.title;
        if (meta?.author_name) channel = meta.author_name;
      }
    } catch { /* offline / blocked — placeholder title is fine */ }
    return {
      tool: 'play_video',
      query,
      ok: true,
      output:
        `Playing: ${title}\n` +
        '(Resolved live by SOHAM\'s YouTube player just now — the URLs are REAL. ' +
        'Never call them made-up or unverifiable; present the video confidently.)\n' +
        `Embed: ${embedUrl}\n` +
        `If the embedded player doesn't load, open it in a new tab: ${watchUrl}`,
      sources: [{ title, url: watchUrl }],
      openUrl: watchUrl,
      embedUrl,
      video: { videoId: id, title, channel, thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` },
    };
  }

  const safeQuery = sanitizeQuery(resolution.query);
  const inferredNote = resolution.reason !== 'explicit query'
    ? ` (inferred from conversation: ${resolution.reason})`
    : '';
  try {
    const { playYouTubeVideo } = await import('./youtube-play');
    const result = await playYouTubeVideo(safeQuery);

    if (!result.ok || !result.videoId || !result.watchUrl || !result.embedUrl) {
      return {
        tool: 'play_video',
        query: result.query || safeQuery,
        ok: false,
        output:
          `Couldn't resolve a playable video for "${result.query || safeQuery}" right now. ` +
          `Open the search results here: ${result.searchUrl || 'https://www.youtube.com/results'}`,
        openUrl: result.searchUrl || 'https://www.youtube.com/results',
      };
    }

    const channelLine = result.channel ? `\nChannel: ${result.channel}` : '';
    return {
      tool: 'play_video',
      query: result.query,
      ok: true,
      output:
        `${verifiedLine(result.title, result.query)}${inferredNote}${channelLine}\n` +
        `Embed: ${result.embedUrl}\n` +
        `If the embedded player doesn't load, open it in a new tab: ${result.watchUrl}`,
      sources: [
        { title: result.title ?? result.query, url: result.watchUrl },
        ...result.candidates.slice(1, 5).map(candidate => ({ title: candidate.title, url: candidate.watchUrl })),
      ],
      openUrl: result.watchUrl,
      embedUrl: result.embedUrl,
      video: {
        videoId: result.videoId,
        title: result.title ?? result.query,
        channel: result.channel,
        thumbnailUrl: result.thumbnailUrl,
      },
    };
  } catch (error) {
    return { tool: 'play_video', query: safeQuery, ok: false, output: `Play video failed: ${String(error)}` };
  }
}

// ─── Web read — fetch a specific page the user is talking about ───────────────
async function webReadTool(query: string, history: ConversationTurnLike[] = []): Promise<SohamToolResult> {
  let url = (query.match(/https?:\/\/[^\s)<>\]]+/i) ?? [])[0];
  if (!url) {
    // Fall back to the most recent URL in the conversation
    for (let i = history.length - 1; i >= 0 && !url; i--) {
      url = (history[i].content.match(/https?:\/\/[^\s)<>\]]+/i) ?? [])[0];
    }
  }
  if (!url) {
    return { tool: 'web_read', query, ok: false, output: 'No URL found. Pass the page URL to read (e.g. "summarize https://example.com/article").' };
  }
  const { readWebPage } = await import('./page-reader');
  const page = await readWebPage(url, 1800);
  if (!page.text) {
    console.warn('[WebRead] page unreadable — Jina and Firecrawl both failed', url.slice(0, 200));
    return { tool: 'web_read', query: url, ok: false, output: `Could not read ${url} — the page is unreachable or blocked. Never invent its contents.`, sources: [{ title: url, url }] };
  }
  console.log(`[WebRead] page read via ${page.via ?? 'jina'} (${page.text.length} chars) — ${url.slice(0, 120)}`);
  return {
    tool: 'web_read',
    query: url,
    ok: true,
    output:
      `Full page content of ${url} (via ${page.via ?? 'jina'} — this is the REAL page text):\n\n${page.text}`,
    sources: [{ title: url, url }],
  };
}

// ─── Wikipedia — encyclopedic lookups ─────────────────────────────────────────
async function wikipediaTool(query: string): Promise<SohamToolResult> {
  const { lookupWikipedia } = await import('./wikipedia');
  const result = await lookupWikipedia(sanitizeQuery(query));
  if (!result.ok) {
    return { tool: 'wikipedia', query, ok: false, output: result.error ?? 'Wikipedia lookup failed.' };
  }
  return {
    tool: 'wikipedia',
    query,
    ok: true,
    output:
      `**${result.title}** (Wikipedia — verified article extract)\n${result.extract}\n\n` +
      `Source: ${result.url}`,
    sources: [{ title: result.title ?? query, url: result.url! }],
  };
}

// ─── Chart — deterministic SVG from real/model-validated numbers ─────────────
async function chartTool(query: string): Promise<SohamToolResult> {
  try {
    const { runChartPipeline } = await import('../flows/chart');
    const chart = await runChartPipeline({ query });
    const noteSuffix = chart.note ? `\n\n_${chart.note}_` : '';
    return {
      tool: 'chart',
      query,
      ok: true,
      output: `**${chart.title}**\n\n${chart.tableMarkdown}${noteSuffix}`,
      chart: { title: chart.title, tableMarkdown: chart.tableMarkdown, imageDataUri: chart.imageDataUri, note: chart.note },
    };
  } catch (err) {
    return { tool: 'chart', query, ok: false, output: `Chart generation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Image generation — sentinel (callers short-circuit to the image pipeline) ─
function imageGenerateSentinel(query: string): SohamToolResult {
  return {
    tool: 'image_generate',
    query,
    ok: true,
    output: '[IMAGE_REQUESTED] The image is being rendered separately by the image pipeline — acknowledge the request briefly in your reply, do not describe or invent the image.',
  };
}

// ─── Summarize — text or conversation excerpt ─────────────────────────────────
async function summarizeTool(query: string): Promise<SohamToolResult> {
  try {
    const { enhancedSummarize } = await import('../flows/enhanced-summarize');
    const text = query.trim();
    if (text.length < 40) {
      return { tool: 'summarize', query, ok: false, output: 'Nothing to summarize — provide the text (or a URL/document) first.' };
    }
    const result = await enhancedSummarize({ text: text.slice(0, 8000), style: 'detailed' });
    return { tool: 'summarize', query, ok: true, output: result.summary ?? String(result).slice(0, 2000) };
  } catch (err) {
    return { tool: 'summarize', query, ok: false, output: `Summarize failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Dispatch by tool name — shared by the regex intent detector and the
 * model-driven agent planner. Never throws: every failure becomes an
 * ok:false result the model can reason about.
 */
// ─── Research sources — flattened, deduped, client-ready ─────────────────────
// Used by the chat routes to emit the `sources` SSE event (chat-stream) and the
// flattened `sources` array (chat-impl). Play URLs are tagged tool:'play_video'
// so the frontend can skip them (they have a dedicated `play` channel).

export interface ResearchSource {
  title: string;
  url: string;
  tool: string;
}

export function collectResearchSources(
  results: ReadonlyArray<SohamToolResult | null | undefined>,
  cap = 12,
): ResearchSource[] {
  const seen = new Set<string>();
  const out: ResearchSource[] = [];
  for (const r of results) {
    if (!r) continue;
    const tool = typeof r.tool === 'string' ? r.tool : 'tool';
    const list = Array.isArray(r.sources) ? r.sources : [];
    for (const s of list) {
      const url = typeof s?.url === 'string' ? s.url.trim() : '';
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      const title = typeof s?.title === 'string' && s.title.trim() ? s.title.trim().slice(0, 200) : url;
      out.push({ title, url, tool });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

export async function runToolByName(
  tool: SohamToolName,
  query: string,
  history: ConversationTurnLike[] = [],
): Promise<SohamToolResult> {
  if (['sports_search', 'weather_search', 'web_search'].includes(tool)) query = resolveDataFollowup(query, history);
  switch (tool) {
    case 'news_search':     return newsSearch(sanitizeQuery(query));
    case 'weather_search':  return weatherSearch(stripInjectedContext(query).slice(0, 300));
    case 'sports_search':   return sportsSearch(sanitizeQuery(query));
    case 'finance_search':  return financeSearch(sanitizeQuery(query));
    case 'web_search':      return webSearch(query);
    case 'play_video':      return playVideoTool(query, history);
    case 'translate':       return translateTool(sanitizeQuery(query));
    case 'sentiment':       return sentimentTool(sanitizeQuery(query));
    case 'grammar':         return grammarTool(sanitizeQuery(query));
    case 'quiz':            return quizTool(sanitizeQuery(query));
    case 'recipe':          return recipeTool(sanitizeQuery(query));
    case 'joke':            return jokeTool(sanitizeQuery(query));
    case 'dictionary':      return dictionaryTool(sanitizeQuery(query));
    case 'fact_check':      return factCheckTool(sanitizeQuery(query));
    case 'web_read':        return webReadTool(query, history);
    case 'wikipedia':       return wikipediaTool(query);
    case 'chart':           return chartTool(query);
    case 'summarize':       return summarizeTool(query);
    case 'image_generate':  return imageGenerateSentinel(query);
    default: return { tool, query, ok: false, output: `Unknown tool: ${tool}` };
  }
}

export async function executeSohamTool(
  message: string,
  history: ConversationTurnLike[] = [],
): Promise<SohamToolResult | null> {
  const intent = detectToolIntent(resolveDataFollowup(message, history));
  if (!intent) return null;
  return runToolByName(intent.tool, intent.query, history);
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
