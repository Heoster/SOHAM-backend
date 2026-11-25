import assert from 'assert';
import { weatherSearch, sportsSearch, matchCricketQuery, weatherLocation, resetLiveDataStateForTests } from '../tools/live-data';
import { resolveDataFollowup, historyContent } from '../utils/followup-context';
import { runSohamAgent } from '../core/soham-agent';
import { playYouTubeVideo } from '../tools/youtube-play';

const originalFetch = globalThis.fetch;
const env = { ...process.env };
async function main() {
  const history = [
    { role: 'user', content: 'play ind VS uae cricket highlight' },
    { role: 'model', content: 'India A vs UAE A 2023 won by eight wickets' },
  ];
  assert.equal(resolveDataFollowup('show info about this match', history), 'ind VS uae cricket match details');
  assert.equal(resolveDataFollowup('search show info about this match', history), 'ind VS uae cricket match details');
  assert.equal(resolveDataFollowup('what is recursion?', history), 'what is recursion?');
  assert.match(resolveDataFollowup('show info about this match in 2023', history), /2023$/);
  assert.equal(resolveDataFollowup('Pakistan vs UAE this match', history), 'Pakistan vs UAE this match');
  assert.equal(resolveDataFollowup('play this video', history), 'play this video');
  assert.equal(resolveDataFollowup('show info about this match', []), 'show info about this match');
  assert.match(historyContent({ content: 'Playing', video: { query: 'IND vs UAE', video: { title: 'India A vs UAE Rising Stars' } } }), /IND vs UAE.*Rising Stars/);
  let executed = '';
  await runSohamAgent('show info about this match', history, {
    plan: { tools: [{ tool: 'sports_search', query: 'Ed Sheeran Sapphire', why: 'incorrect model query' }], memoryExtract: false },
    runners: { sports_search: async query => { executed = query; return { tool: 'sports_search', query, ok: false, output: 'test' }; } },
  });
  assert.match(executed, /ind VS uae/);
  assert.doesNotMatch(executed, /Sheeran|2023/);
  assert.equal(matchCricketQuery({ name: 'Malaysia Women vs Indonesia Women', date: '2026-01-01' }, 'IND vs UAE'), false);
  assert.equal(matchCricketQuery({ name: 'India A vs United Arab Emirates', date: '2023-07-13' }, 'IND vs UAE 2026'), false);
  assert.equal(matchCricketQuery({ name: 'India A vs United Arab Emirates', date: '2026-11-01' }, 'IND vs UAE 2026'), true);
  process.env.CRICKETDATA_API_KEY = 'test-secret';
  let calls = 0;
  globalThis.fetch = (async (input: any) => {
    calls++;
    assert.ok(String(input).startsWith('https://api.cricapi.com/v1/currentMatches'));
    return Response.json({ status: 'success', data: [
      { name: 'Malaysia vs Indonesia', date: '2026-11-01' },
      { name: 'India A vs United Arab Emirates', dateTimeGMT: '2026-11-01T10:00:00', status: 'India A won', score: [{ inning: 'India A', r: 180, w: 2, o: 19.4 }] },
    ] });
  }) as typeof fetch;
  const cricket = await sportsSearch('IND vs UAE 2026');
  assert.ok(cricket.ok);
  assert.match(cricket.output, /180\/2/);
  assert.doesNotMatch(cricket.output, /Malaysia/);
  assert.ok(cricket.sources?.length);
  assert.equal(calls, 1);
  await sportsSearch('IND vs UAE 2026');
  assert.equal(calls, 1, 'public feed should be reused across requests');
  let fallbacks = 0;
  const search = async () => { fallbacks++; return { results: [
    { title: 'Ed Sheeran Sapphire', snippet: 'music video', url: 'https://example.com/music' },
    { title: 'India vs UAE cricket', snippet: '2026 match report', url: 'https://example.com/cricket' },
  ] }; };
  for (const mode of ['quota', 'http', 'invalid', 'empty']) {
    resetLiveDataStateForTests();
    globalThis.fetch = (async () => mode === 'http' ? new Response('', { status: 429 }) : mode === 'invalid' ? new Response('broken JSON') : Response.json(mode === 'empty' ? { status: 'success', data: [] } : { status: 'failure', reason: 'quota' })) as typeof fetch;
    const result = await sportsSearch('IND vs UAE 2026', { search });
    assert.ok(result.ok);
    assert.match(result.output, /NOT verified live/);
    assert.equal(result.sources?.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /test-secret|Sheeran/);
  }
  assert.equal(fallbacks, 4);
  resetLiveDataStateForTests();
  globalThis.fetch = (async () => Response.json({ status: 'success', data: [] })) as typeof fetch;
  const oldOnly = await sportsSearch('IND vs UAE', { search: async () => ({ results: [{ title: 'India vs UAE cricket 2023', snippet: 'old scorecard', url: 'https://example.com/old' }] }) });
  assert.equal(oldOnly.ok, false, 'do not substitute an old match when date is unresolved');
  resetLiveDataStateForTests();
  let rejectedCalls = 0;
  globalThis.fetch = (async () => { rejectedCalls++; return new Response('', { status: 429 }); }) as typeof fetch;
  await sportsSearch('IND vs UAE', { search });
  await sportsSearch('IND vs UAE', { search });
  assert.equal(rejectedCalls, 1, 'provider rejection must trigger cooldown');
  resetLiveDataStateForTests();
  delete process.env.CRICKETDATA_API_KEY;
  delete process.env.CRICAPI_KEY;
  const none = await sportsSearch('IND vs UAE 2026', { search: async () => { throw new Error('offline'); } });
  assert.equal(none.ok, false);
  assert.match(none.output, /do not guess/);
  assert.equal(weatherLocation('will it rain in Delhi tomorrow?'), 'Delhi');
  assert.equal(weatherLocation('weather in Shāmli today'), 'Shāmli');
  const missing = await weatherSearch('weather here');
  assert.equal(missing.ok, false);
  assert.match(missing.output, /Which city/);
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.includes('geocoding-api')) return Response.json({ results: [{ latitude: 28.6, longitude: 77.2, name: 'Delhi', country: 'India' }] });
    assert.ok(url.includes('daily='));
    return Response.json({ timezone: 'Asia/Kolkata', current: { temperature_2m: 24, relative_humidity_2m: 60, time: '2026-11-01T12:00' }, daily: { time: ['2026-11-01', '2026-11-02'], temperature_2m_min: [18, 19], temperature_2m_max: [29, 30], precipitation_probability_max: [5, 25] } });
  }) as typeof fetch;
  const weather = await weatherSearch('weather Delhi tomorrow');
  assert.ok(weather.ok);
  assert.match(weather.output, /humidity 60%/);
  assert.match(weather.output, /2026-11-02: 19–30°C; rain chance 25%/);
  assert.ok(weather.sources?.[0].url.startsWith('https://api.open-meteo.com/'));
  globalThis.fetch = (async () => { throw new Error('timeout'); }) as typeof fetch;
  const weatherDown = await weatherSearch('weather Delhi', { search: async () => ({ results: [] }) });
  assert.equal(weatherDown.ok, false);

  // Attachment regression: oEmbed failure must not keep an opaque thumbnail hit first.
  globalThis.fetch = (async (input: any) => {
    if (String(input).startsWith('https://r.jina.ai/')) return new Response('https://www.youtube.com/watch?v=6cLbaxGXFio\n[India A vs UAE Highlights](https://www.youtube.com/watch?v=mAFVLQJOxTQ)');
    return new Response('', { status: 503 });
  }) as typeof fetch;
  const video = await playYouTubeVideo('IND vs UAE unit resilient title');
  assert.equal(video.title, 'India A vs UAE Highlights');
  assert.equal(video.candidates[0].videoId, 'mAFVLQJOxTQ');
  console.log('Live-data recovery, context, weather, cricket and video regression checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { globalThis.fetch = originalFetch; process.env = env; resetLiveDataStateForTests(); });
