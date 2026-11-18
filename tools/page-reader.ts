/**
 * Page Reader — fetch the readable content of a web page.
 *
 * Used after search: SOHAM shouldn't answer from snippets alone, so the
 * top result pages are read and injected as context (with citations).
 *
 * Priority (standing rule): Jina Reader is PRIMARY — Firecrawl is the
 * fallback only. r.jina.ai works without a key (rate-limited); a key raises
 * the limits (JINA_API_KEY). Firecrawl needs FIRECRAWL_API_KEY.
 */

const JINA_ACCEPT_TEXT = 'text/plain';

function capText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars).trimEnd() + '…';
}

/** Jina Reader — https://r.jina.ai/<url> */
export async function readWithJina(url: string): Promise<string> {
  const key = process.env.JINA_API_KEY;
  const res = await fetch(`https://r.jina.ai/${url}`, {
    method: 'GET',
    headers: {
      Accept: JINA_ACCEPT_TEXT,
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) return '';
  const text = await res.text();
  return text.trim();
}

/** Firecrawl scrape — https://api.firecrawl.dev/v1/scrape */
export async function readWithFirecrawl(url: string): Promise<string> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return '';
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, timeout: 8000 }),
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) return '';
  const data = await res.json() as any;
  return String(data?.data?.markdown ?? data?.data?.content ?? '').trim();
}

/**
 * Read a single page. Returns the text plus which reader succeeded,
 * or an empty string when every reader fails (never throws).
 */
export async function readWebPage(url: string, maxChars = 1800): Promise<{ text: string; via?: 'jina' | 'firecrawl' }> {
  if (!/^https?:\/\//i.test(url)) return { text: '' };
  // Jina Reader for YouTube URLs — reader pages are markdown-friendly
  try {
    const viaJina = capText(await readWithJina(url), maxChars);
    if (viaJina.length >= 80) return { text: viaJina, via: 'jina' };
  } catch { /* try firecrawl */ }
  try {
    const viaFirecrawl = capText(await readWithFirecrawl(url), maxChars);
    if (viaFirecrawl.length >= 80) return { text: viaFirecrawl, via: 'firecrawl' };
  } catch { /* give up */ }
  return { text: '' };
}

/**
 * Read the top N URLs in parallel. Never throws; failures are omitted.
 */
export async function readTopPages(urls: string[], topN = 2, maxChars = 1500): Promise<Array<{ url: string; text: string; via?: 'jina' | 'firecrawl' }>> {
  const picked = urls.filter(u => /^https?:\/\//i.test(u)).slice(0, topN);
  const results = await Promise.allSettled(picked.map(u => readWebPage(u, maxChars)));
  return results
    .map((r, i) => ({ url: picked[i], ...(r.status === 'fulfilled' ? r.value : { text: '' }) }))
    .filter(r => r.text.length > 0);
}
