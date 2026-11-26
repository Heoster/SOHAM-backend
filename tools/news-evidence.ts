import type { SearchResult } from './search-engine';
import type { SohamToolResult } from './agent-tools';

const indiaTopic = /\bindia(?:n)?\b|\b(delhi|lucknow|uttar pradesh|mumbai|bengaluru|chennai|kolkata|modi|kharge|adityanath|parliament|lok sabha|rajya sabha)\b/i;

/** Rank before the pipeline's top-10 cut, not merely by incomparable provider scores. */
export function rankNewsEvidence(results: SearchResult[], query: string, now = Date.now()): SearchResult[] {
  const wantsIndia = /\bindia(?:n)?\b/i.test(query);
  const window = /\btoday|headlines|breaking\b/i.test(query) ? 36 * 3600_000 : /\blatest|recent\b/i.test(query) ? 7 * 86400_000 : undefined;
  return results.filter(result => {
    if (!result.title || !/^https?:\/\//i.test(result.url)) return false;
    try { new URL(result.url); } catch { return false; }
    const text = `${result.title} ${result.snippet}`;
    if (wantsIndia && !indiaTopic.test(text) && !/\/(india|national)\//i.test(result.url)) return false;
    // A publisher's nationality alone does not make a US story India news.
    if (wantsIndia && /\/(?:world\/)?us-news\//i.test(result.url) && !indiaTopic.test(result.title)) return false;
    const time = Date.parse(result.publishedAt || '');
    if (Number.isFinite(time) && (time > now + 3600_000 || (window && time < now - window))) return false;
    return true;
  }).map((result, index) => {
    const time = Date.parse(result.publishedAt || '');
    const freshness = Number.isFinite(time) ? Math.max(0, 1 - (now - time) / (7 * 86400_000)) : 0;
    return { result, index, rank: (wantsIndia && indiaTopic.test(result.title) ? 2 : 0) + freshness + Math.max(0, Math.min(1, result.score || 0)) * 0.1 };
  }).sort((a, b) => b.rank - a.rank || a.index - b.index).map(row => row.result);
}

function compact(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Keep every selected headline inside the agent's 2200-character output budget. */
export function buildNewsEvidence(query: string, results: SearchResult[], now = Date.now()): SohamToolResult {
  const articles = rankNewsEvidence(results, query, now).slice(0, 6);
  return {
    tool: 'news_search', query, ok: articles.length > 0,
    output: articles.length ? `Found ${articles.length} relevant news report(s). Summarize these available headlines; do not describe the whole search as failed. Unknown publication dates are NOT confirmed today. Retrieved ${new Date(now).toISOString()}.\n` + articles.map((article, index) => {
      const date = Date.parse(article.publishedAt || '');
      const label = Number.isFinite(date) ? new Date(date).toISOString().slice(0, 16) + 'Z' : 'publication time unknown';
      return `[${index + 1}] ${compact(article.title, 100)} (${label})\n${compact(article.snippet || '', 70)}\nSource: ${article.url.length <= 100 ? article.url : new URL(article.url).hostname.slice(0, 45)}`;
    }).join('\n\n') : 'No relevant, sufficiently recent reports were returned. Explain this limitation without inventing headlines.',
    sources: articles.map(article => ({ title: article.title, url: article.url })),
  };
}
