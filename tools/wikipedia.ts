/**
 * Wikipedia — encyclopedic lookups (free, no key).
 *
 * opensearch → canonical title → REST summary. Returns a clean extract
 * with the article URL. Never throws; returns ok:false on any failure.
 */

export interface WikipediaResult {
  ok: boolean;
  title?: string;
  extract?: string;
  url?: string;
  error?: string;
}

export async function lookupWikipedia(query: string): Promise<WikipediaResult> {
  const q = query.trim().slice(0, 300);
  if (q.length < 2) return { ok: false, error: 'Query too short' };

  try {
    const search = await fetch(
      `https://en.wikipedia.org/w/api.php?origin=*&action=opensearch&search=${encodeURIComponent(q)}&limit=1&namespace=0&format=json`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7000) },
    );
    if (!search.ok) return { ok: false, error: `Wikipedia search failed: HTTP ${search.status}` };
    const data = await search.json() as any;
    const title: string | undefined = data?.[1]?.[0];
    if (!title) return { ok: false, error: `No Wikipedia article found for "${q}"` };

    const sum = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7000) },
    );
    if (!sum.ok) return { ok: false, error: `Wikipedia summary failed: HTTP ${sum.status}` };
    const body = await sum.json() as any;
    const extract: string = body?.extract ?? '';
    if (!extract) return { ok: false, error: `Wikipedia article "${title}" has no usable summary` };
    return {
      ok: true,
      title: body?.title ?? title,
      extract,
      url: body?.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
