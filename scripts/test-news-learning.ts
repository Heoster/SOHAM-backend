import assert from 'assert';
import { rankNewsEvidence, buildNewsEvidence } from '../tools/news-evidence';
import type { SearchResult } from '../tools/search-engine';
import { executeAgentPlan } from '../core/soham-agent';
import { stripInjectedContext } from '../utils/clean-message';
import { shouldLearnPublicQA, hideUnsafePublicEntry } from '../memory/public-learning-policy';
import { autoLearnQAPair, triggerAutoLearn } from '../memory/rag-auto-learn';
import { getPineconeKnowledgeService } from '../memory/pinecone-knowledge-service';

const env = { ...process.env };
const now = Date.parse('2026-11-26T09:40:00Z');
const question = "What are today's top news headlines in India?";
const stableQuestion = 'What is photosynthesis?';
const stableAnswer = 'Photosynthesis converts light energy into chemical energy. Plants use carbon dioxide and water to produce sugars, releasing oxygen as a byproduct.';
const service = getPineconeKnowledgeService();
const store = service.storeKnowledge;
async function main() {
  const result = (title: string, url: string, publishedAt?: string): SearchResult => ({ title, url, publishedAt, snippet: 'A recent report with details about the event.', score: 1, source: 'mock' });
  const reports = [
    result('Trump discusses US healthcare', 'https://www.indiatoday.in/world/us-news/story/trump'),
    result('Congress march permission denied in Lucknow', 'https://www.timesnownews.com/india/congress', '2026-11-26T06:00:00Z'),
    result('India crop estimate revised', 'https://www.example.com/india-crops', '2026-11-24T00:00:00Z'),
    result('India Parliament debates bill', 'https://www.example.com/national/bill', '2026-11-26T07:00:00Z'),
  ];
  const ranked = rankNewsEvidence(reports, question, now);
  assert.equal(ranked.length, 2, 'exclude unrelated US lead and stale report');
  assert.match(ranked[0].title, /Parliament/);
  const evidence = buildNewsEvidence(question, reports, now);
  assert.ok(evidence.ok);
  assert.match(evidence.output, /Found 2/);
  assert.match(evidence.output, /Lucknow/);
  assert.equal(evidence.sources?.length, 2);
  assert.doesNotMatch(evidence.output, /Trump|crop/);
  const huge = Array.from({ length: 6 }, (_, i) => ({ ...result(`India headline ${i} ` + 'x'.repeat(1000), `https://example.com/story/${i}`), snippet: 'y'.repeat(20_000) }));
  const compact = buildNewsEvidence(question, huge, now);
  assert.ok(compact.output.length <= 2200, `headline pack too large: ${compact.output.length}`);
  const executed = await executeAgentPlan({ tools: [{ tool: 'news_search', query: question }], memoryExtract: false }, { history: [] }, { runners: { news_search: async () => compact } });
  for (let i = 1; i <= 6; i++) assert.ok(executed[0].output.includes(`[${i}]`), 'all selected headlines survive execution cap');
  assert.equal(executed[0].sources?.length, 6);
  assert.match(compact.output, /publication time unknown/);
  assert.equal(buildNewsEvidence(question, reports.slice(0, 1), now).ok, false);
  const polluted = `${question}USER_MEMORY\npref: short response\nSOHAM_CLOCK\nUTC now: 2026-11-26 Never guess it.`;
  assert.equal(stripInjectedContext(polluted), question);
  assert.equal(stripInjectedContext('Explain USER_MEMORY layout in my source file.'), 'Explain USER_MEMORY layout in my source file.');
  let writes = 0;
  service.storeKnowledge = async () => { writes++; return 'test'; };
  delete process.env.SOHAM_PUBLIC_AUTO_LEARN_ENABLED;
  await autoLearnQAPair(stableQuestion, stableAnswer, 'test');
  triggerAutoLearn({ userMessage: polluted, assistantMessage: stableAnswer, modelUsed: 'test', toolResults: [] });
  assert.equal(writes, 0, 'public publishing is disabled by default');
  process.env.SOHAM_PUBLIC_AUTO_LEARN_ENABLED = '1';
  await autoLearnQAPair(polluted, stableAnswer, 'test');
  await autoLearnQAPair(question, stableAnswer, 'test');
  await autoLearnQAPair(stableQuestion, "I couldn't fetch the data. " + stableAnswer, 'test');
  await autoLearnQAPair(stableQuestion, stableAnswer, 'test', true);
  assert.equal(writes, 0, 'private, transient, refusal and tool-derived QAs must not become FAQs');
  await autoLearnQAPair(stableQuestion, stableAnswer, 'test');
  assert.equal(writes, 1, 'explicitly enabled safe stable FAQ can still be stored');
  assert.equal(shouldLearnPublicQA('What is my password?', stableAnswer), false);
  assert.equal(hideUnsafePublicEntry({ question: polluted, content: stableAnswer }), true);
  assert.equal(hideUnsafePublicEntry({ question, content: stableAnswer, source: 'soham-test' }), true);
  assert.equal(hideUnsafePublicEntry({ question: stableQuestion, content: stableAnswer, source: 'curated' }), false);
  console.log('News evidence packing, relevance, privacy and public-learning checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { process.env = env; service.storeKnowledge = store; });
