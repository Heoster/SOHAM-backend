import type { SohamToolResult } from './agent-tools';

export interface LiveDataDeps { search?: (query: string) => Promise<{ results: Array<{ title: string; snippet: string; url: string }> }> }

async function json(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(4500) });
  if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
  return response.json();
}

/** One bounded fallback, not an unbounded retry loop. Never treats snippets as live scores. */
async function fallback(tool: 'sports_search' | 'weather_search', query: string, deps: LiveDataDeps): Promise<SohamToolResult> {
  try {
    const { runSearchPipeline } = await import('./search-engine');
    const result = await (deps.search || runSearchPipeline)(query);
    const terms = query.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter(t => !['show','info','about','this','match','cricket','weather','search','please','current','live','score','forecast'].includes(t)) || [];
    const rows = result.results.filter(r => {
      if (tool === 'sports_search') {
        const text = `${r.title} ${r.snippet}`;
        const datedYears = text.match(/\b20\d{2}\b/g) || [];
        if (!/\b20\d{2}\b/.test(query) && datedYears.some(year => Number(year) < new Date().getUTCFullYear())) return false;
        return /cricket|innings|overs|wickets|\bvs\b/i.test(text) && matchCricketQuery({ name: text }, query);
      }
      const text = `${r.title} ${r.snippet}`.toLowerCase();
      return terms.length > 0 && terms.every(t => text.includes(t));
    }).slice(0, 3);
    return {
      tool, query, ok: rows.length > 0,
      output: rows.length ? 'Direct provider unavailable or no exact match. These are web references, NOT verified live data. Confirm teams, tournament and date; do not substitute an older match.\n' + rows.map(r => `${r.title}: ${r.snippet}`).join('\n') : 'No matching verified data available. Ask for the exact teams/date/tournament or city. Do not invent scores, results, or weather.',
      sources: rows.map(r => ({ title: r.title, url: r.url })),
    };
  } catch {
    return { tool, query, ok: false, output: 'Live lookup and fallback unavailable. Explain the limitation and ask for the missing match identity or city; do not guess.' };
  }
}

const aliases: Record<string, string> = { ind: 'india', uae: 'united arab emirates', pak: 'pakistan', aus: 'australia', eng: 'england', nz: 'new zealand', sa: 'south africa' };
function normalize(text: string): string {
  return text.toLowerCase().replace(/\b(ind|uae|pak|aus|eng|nz|sa)\b/g, x => aliases[x]).replace(/[^a-z0-9]+/g, ' ').trim();
}

export function matchCricketQuery(match: any, query: string): boolean {
  if (typeof match?.name !== 'string') return false;
  const identity = normalize(`${match.name} ${(Array.isArray(match.teams) ? match.teams : []).join(' ')} ${match.dateTimeGMT || match.date || ''}`);
  const q = normalize(query);
  const years = q.match(/\b20\d{2}\b/g) || [];
  if (years.some(y => !identity.includes(y))) return false;
  // Both opponents must match, not just the first eight matches in the feed.
  const pair = q.match(/([a-z ]+)\s+(?:vs|versus|v)\s+([a-z ]+)/);
  if (pair) {
    const clean = (s: string) => s.replace(/\b(play|watch|highlights?|cricket|show|info|about|search|score|live|match|details|of|the|this|today|current|now)\b/g, ' ').trim();
    return [clean(pair[1]), clean(pair[2])].every(team => team.length > 1 && identity.includes(team));
  }
  const mentioned = Object.values(aliases).filter(team => q.includes(team));
  if (mentioned.length) return mentioned.every(team => identity.includes(team));
  return /^(?:live |current |today s? )?(?:cricket )?(?:matches|scores|fixtures)$/i.test(query.trim());
}

// Public feed cache + single-flight prevents concurrent users consuming one
// quota hit each. A short circuit-breaker stops hammering a rejected provider.
let feedState: { key: string; expires: number; blockedUntil: number; data?: any[]; fetchedAt?: number; pending?: Promise<{ data: any[]; fetchedAt: number }> } | undefined;
export function resetLiveDataStateForTests(): void { feedState = undefined; }
async function cricketFeed(key: string): Promise<{ data: any[]; fetchedAt: number }> {
  if (!feedState || feedState.key !== key) feedState = { key, expires: 0, blockedUntil: 0 };
  const state = feedState;
  if (state.data && state.expires > Date.now()) return { data: state.data, fetchedAt: state.fetchedAt! };
  if (state.blockedUntil > Date.now()) throw new Error('Cricket provider cooling down');
  if (state.pending) return state.pending;
  state.pending = (async () => {
    try {
      const payload = await json(`https://api.cricapi.com/v1/currentMatches?apikey=${encodeURIComponent(key)}&offset=0`);
      if (payload.status !== 'success' || !Array.isArray(payload.data)) throw new Error('Invalid cricket response');
      state.data = payload.data;
      state.fetchedAt = Date.now();
      state.expires = state.fetchedAt + 60_000;
      return { data: payload.data, fetchedAt: state.fetchedAt };
    } catch (error) {
      state.blockedUntil = Date.now() + 60_000;
      throw error;
    } finally { state.pending = undefined; }
  })();
  return state.pending;
}

export async function sportsSearch(query: string, deps: LiveDataDeps = {}): Promise<SohamToolResult> {
  const key = process.env.CRICKETDATA_API_KEY || process.env.CRICAPI_KEY;
  if (key && !/\b(football|soccer|basketball|tennis)\b/i.test(query)) {
    try {
      const payload = await cricketFeed(key);
      const matches = payload.data.filter((m: any) => matchCricketQuery(m, query)).slice(0, 4);
      if (matches.length) return {
        tool: 'sports_search', query, ok: true,
        output: `CricketData feed retrieved ${new Date(payload.fetchedAt).toISOString()} (cached up to 60 seconds). Multiple matches require clarification of date/tournament before choosing one. Feed can be delayed; status is provider-reported, not proof of realtime play.\n` + matches.map((m: any) => `${m.name}\nDate: ${m.dateTimeGMT || m.date || 'unknown'} UTC; venue: ${m.venue || 'unknown'}\nStatus: ${m.status || 'unknown'}\n` + (Array.isArray(m.score) ? m.score.map((s: any) => `${s.inning || 'Innings'}: ${s.r ?? '?'}/${s.w ?? '?'} (${s.o ?? '?'} overs)`).join('; ') : 'Score unavailable')).join('\n\n'),
        sources: [{ title: 'CricketData current matches feed', url: 'https://cricketdata.org/cricket-data-formats/matches' }],
      };
    } catch { /* Authentication, quota, timeout, malformed JSON: one fallback below. */ }
  }
  return fallback('sports_search', query, deps);
}

export function weatherLocation(query: string): string {
  return query.replace(/\b(what(?:'s| is)|how(?:'s| is)|tell me|show me|please|weather|temperature|forecast|humidity|rain|rainfall|today|tomorrow|tonight|this week|next week|current|now|in|at|for|the|like|will|it|be|mausam|baarish)\b/gi, ' ').replace(/[?!]/g, '').replace(/\s+/g, ' ').trim();
}

export async function weatherSearch(query: string, deps: LiveDataDeps = {}): Promise<SohamToolResult> {
  const location = weatherLocation(query);
  if (!location || /^(here|my location|near me)$/i.test(location)) return { tool: 'weather_search', query, ok: false, output: 'Which city and country? No reliable location was supplied; do not assume a default city.' };
  try {
    const geo = await json(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=3&language=en&format=json`);
    const place = geo.results?.[0];
    if (!place || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) throw new Error('No geocoding match');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=7&timezone=auto`;
    const data = await json(url);
    if (!Number.isFinite(data.current?.temperature_2m) || !Array.isArray(data.daily?.time)) throw new Error('Incomplete weather response');
    return {
      tool: 'weather_search', query, ok: true,
      output: `Open-Meteo for ${place.name}, ${place.admin1 || ''}, ${place.country || ''} (${place.latitude}, ${place.longitude}). Geocoding selected this location; clarify if a different city was intended.\nCurrent model estimate at ${data.current.time} (${data.timezone || 'local'}): ${data.current.temperature_2m}°C, humidity ${data.current.relative_humidity_2m ?? '?'}%, wind ${data.current.wind_speed_10m ?? '?'} km/h.\n7-day forecast (not historical observations):\n` + data.daily.time.slice(0, 7).map((day: string, i: number) => `${day}: ${data.daily.temperature_2m_min?.[i] ?? '?'}–${data.daily.temperature_2m_max?.[i] ?? '?'}°C; rain chance ${data.daily.precipitation_probability_max?.[i] ?? '?'}%`).join('\n'),
      sources: [{ title: 'Open-Meteo forecast data', url }],
    };
  } catch { return fallback('weather_search', query, deps); }
}
