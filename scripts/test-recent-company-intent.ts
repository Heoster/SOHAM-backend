import assert from 'node:assert/strict';
import { detectToolIntent, executeSohamTool } from '../tools/agent-tools';
import { analyzeQuery, runSearchPipeline, selectSources } from '../tools/search-engine';

const recentCompanyQuestions = [
  'what happen with nvidea in last some hours',
  'What happened to Nvidia in the last few hours?',
  'What happened to Anthropic in the last few hours?',
  'Any updates about Apple in the past couple of hours?',
  'What is going on with OpenAI today?',
  'what happen with Anthropic in last some hours',
];

for (const query of recentCompanyQuestions) {
  const intent = detectToolIntent(query);
  assert.equal(intent?.tool, 'news_search', `Expected news search for: ${query}`);

  const analysis = analyzeQuery(query);
  assert.equal(analysis.queryType, 'news', `Expected news query classification for: ${query}`);
  if (/nvidea/i.test(query)) {
    assert.match(analysis.cleanQuery, /NVIDIA/i, 'Search query should normalize the common Nvidia typo');
  }
}

void (async () => {
  const envKeys = ['TAVILY_API_KEY', 'YOU_API_KEY', 'GNEWS_API_KEY', 'BRAVE_SEARCH_API_KEY', 'SERPAPI_KEY', 'JINA_API_KEY', 'FIRECRAWL_API_KEY', 'NEWS_API_KEY'];
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  try {
    for (const key of envKeys) delete process.env[key];

    const analysis = analyzeQuery('what happen with nvidea in last some hours');
    const sources = selectSources(analysis);
    assert.ok(sources.includes('google-news-rss'), 'News searches should always use the no-key live RSS provider');
    assert.ok(sources.includes('duckduckgo'), 'News searches should retain a real web-search fallback');

    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      requested.push(url.href);
      if (url.hostname === 's.jina.ai') {
        return new Response(JSON.stringify({ data: [{ title: 'Jina live result', url: 'https://jina.example/news', content: 'Jina indexed live result.' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'api.firecrawl.dev' && url.pathname === '/v2/search') {
        return new Response(JSON.stringify({ success: true, data: { news: [{ title: 'Firecrawl live result', url: 'https://firecrawl.example/news', snippet: 'Firecrawl indexed live result.', date: '2026-11-13' }], web: [] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'newsapi.org') {
        assert.equal((init?.headers as Record<string, string>)?.['X-Api-Key'], 'mock-news-key');
        assert.equal(url.searchParams.get('sortBy'), 'publishedAt');
        assert.ok(url.searchParams.get('from'), 'NewsAPI requests must be bounded to recent articles');
        return new Response(JSON.stringify({ status: 'ok', articles: [{
          title: 'NewsAPI live result', url: 'https://newsapi.example/article', description: 'NewsAPI article snippet.',
          publishedAt: new Date().toISOString(), source: { name: 'Mock Publisher' },
        }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'news.google.com') {
        return new Response(
          '<rss><channel><item><title>Chipmaker launches new products - Test Publisher</title>' +
          '<link>https://news.google.com/rss/articles/test-article</link>' +
          '<description>Company announcement with verifiable details.</description>' +
          '<source>Test Publisher</source><pubDate>Fri, 14 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>',
          { status: 200, headers: { 'Content-Type': 'application/rss+xml' } },
        );
      }
      if (url.hostname === 'html.duckduckgo.com') {
        return new Response(
          '<div class="result"><a class="result__a" href="https://example.com/company-news">Company news</a>' +
          '<div class="result__snippet">A second searchable result.</div></div>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const live = await runSearchPipeline('what happen with nvidea in last some hours');
    assert.equal(live.queryType, 'news');
    assert.ok(live.results.some(result => result.title.includes('Chipmaker launches new products')),
      'RSS article should enter normalized live search results');
    assert.ok(live.results.some(result => result.publishedAt), 'Live news results should retain publication timestamps');
    assert.ok(live.results.some(result => result.url === 'https://example.com/company-news'),
      'Full-web fallback results should be merged with news articles');
    const rssRequest = requested.find(url => url.includes('news.google.com/rss/search'));
    assert.ok(rssRequest, 'Google News RSS provider should be queried');
    assert.match(decodeURIComponent(rssRequest!), /NVIDIA when:6h/i,
      'Recent searches should add an explicit provider time window');

    const toolResult = await executeSohamTool('what happen with NVIDIA in last some hours');
    assert.equal(toolResult?.tool, 'news_search', 'The chat tool should dispatch recent-company questions to the unified engine');
    assert.ok(toolResult?.output.includes('https://news.google.com/rss/articles/test-article'),
      'The chat tool context must retain clickable news citations');

    process.env.JINA_API_KEY = 'mock-jina-key';
    process.env.FIRECRAWL_API_KEY = 'mock-firecrawl-key';
    process.env.NEWS_API_KEY = 'mock-news-key';
    const expanded = await runSearchPipeline('what happen with NVIDIA in last some hours');
    assert.ok(expanded.results.some(result => result.source === 'jina'), 'Configured Jina results should join the shared search index');
    assert.ok(expanded.results.some(result => result.source === 'firecrawl'), 'Configured Firecrawl news results should join the shared search index');
    assert.ok(expanded.results.some(result => result.source === 'newsapi:Mock Publisher'), 'Configured NewsAPI.org results should join the shared search index');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  console.log(`Recent-company live-search integration checks passed (${recentCompanyQuestions.length} intent cases).`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
