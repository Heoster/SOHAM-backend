/**
 * Mocked checks for the deterministic chart path.
 * Run: node -r ts-node/register/transpile-only scripts/test-chart.ts
 */
import assert from 'node:assert/strict';
import { getIntentDetector } from '../core/intent-detector';
import {
  escapeXml,
  formatCompactValue,
  formatFullValue,
  parseChartJson,
  renderBarChartSvg,
  specToMarkdownTable,
  specToSvgDataUri,
  type ChartSpec,
} from '../tools/chart-generator';

const detector = getIntentDetector();

// ─── 1) Intent routing — the exact production repro ─────────────────────────
const repro = detector.detect('Compare the population of the 5 largest Indian cities in a table and draw a chart of it');
assert.equal(repro.intent, 'CHART_GENERATION', `expected CHART_GENERATION, got ${repro.intent}`);
assert.ok(repro.confidence >= 0.9, `chart confidence too low: ${repro.confidence}`);

const combined = detector.detect('Set a 25 minute timer AND Compare the population of the 5 largest Indian cities in a table and draw a chart of it');
assert.equal(combined.intent, 'CHART_GENERATION', `combined timer+chart must route to chart, got ${combined.intent}`);

assert.equal(detector.detect('draw a bar chart of quarterly revenue').intent, 'CHART_GENERATION');
assert.equal(detector.detect('plot a graph of apple vs google stock growth').intent, 'CHART_GENERATION');
assert.equal(detector.detect('show me a histogram of response times').intent, 'CHART_GENERATION');
assert.equal(detector.detect('create a pie chart of budget distribution').intent, 'CHART_GENERATION');

// Real image requests must stay images
assert.equal(detector.detect('draw me a picture of a sunset over mountains').intent, 'IMAGE_GENERATION');
assert.equal(detector.detect('generate a poster for my sister').intent, 'IMAGE_GENERATION');
assert.equal(detector.detect('draw a cute robot with neon lights').intent, 'IMAGE_GENERATION');

// Data questions without chart words must NOT become charts
assert.notEqual(detector.detect('population of India').intent, 'CHART_GENERATION');

// ─── 2) parseChartJson ──────────────────────────────────────────────────────
const goodJson = parseChartJson('{"title":"Indian Metro Population","unit":"population","note":"Approx. UN 2024 estimates","items":[{"label":"Delhi","value":32860000},{"label":"Mumbai","value":21710000},{"label":"Kolkata","value":15118000},{"label":"Bengaluru","value":13608000},{"label":"Chennai","value":11700000}]}');
assert.ok(goodJson, 'valid JSON should parse');
assert.equal(goodJson!.items.length, 5);
assert.equal(goodJson!.items[0].label, 'Delhi');
assert.equal(goodJson!.unit, 'population');

const fenced = parseChartJson('```json\n{"title":"t","items":[{"label":"a","value":3},{"label":"b","value":2}]}\n```');
assert.ok(fenced, 'fenced JSON should parse');

const proseAround = parseChartJson('Sure! Here you go:\n{"title":"t","items":[{"label":"a","value":3},{"label":"b","value":2}]}\nHope this helps!');
assert.ok(proseAround, 'JSON embedded in prose should parse');

assert.equal(parseChartJson('no json at all'), null);
assert.equal(parseChartJson('{"title":"t","items":[{"label":"only","value":1}]}'), null, 'fewer than 2 items must fail');
assert.equal(parseChartJson('{"title":"t","items":[{"label":"a","value":"lots"},{"label":"b","value":2}]}'), null, 'string values must fail');
assert.equal(parseChartJson('{"title":"t","items":[{"label":"a","value":NaN},{"label":"b","value":2}]}'), null, 'NaN must fail');

const capped = parseChartJson(`{"title":"big","items":${JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`, value: i + 1 })))}}`);
assert.equal(capped!.items.length, 8, 'items must be capped at 8');

// ─── 3) Deterministic rendering from the same numbers ───────────────────────
const spec: ChartSpec = {
  title: 'Top 5 Indian Cities by Population & Growth',
  unit: 'population',
  note: 'Approx. UN 2024 estimates',
  items: [
    { label: 'Delhi', value: 32860000 },
    { label: 'Mumbai', value: 21710000 },
    { label: 'Kolkata', value: 15118000 },
    { label: 'Bengaluru', value: 13608000 },
    { label: 'Chennai', value: 11700000 },
  ],
};
const svg = renderBarChartSvg(spec);
assert.match(svg, /^<svg[^>]+width="920"/);
assert.ok(svg.includes('Top 5 Indian Cities'), 'title rendered');
assert.ok(svg.includes('&amp;'), 'XML entities escaped in title');
assert.ok(!svg.includes(' & '), 'raw ampersand must not appear');
assert.equal((svg.match(/<rect/g) || []).length, 6, 'background + 5 bars'); // bg rect + 5 bars
assert.ok(svg.includes('32.86M'), 'compact value label present');

const uri = specToSvgDataUri(spec);
assert.ok(uri.startsWith('data:image/svg+xml;base64,'));
const decoded = Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
assert.ok(decoded.startsWith('<svg'), 'data URI decodes back to the SVG');
assert.ok(!decoded.includes('<script'), 'no scripts in the SVG');

// ─── 4) Markdown table ──────────────────────────────────────────────────────
const table = specToMarkdownTable(spec);
assert.match(table, /\| # \| Item \| Value \(population\) \|/);
assert.match(table, /\| 1 \| Delhi \| 32,860,000 \|/);
assert.equal(table.split('\n').length, 7, 'header + separator + 5 rows');

const piped = specToMarkdownTable({ title: 't', items: [{ label: 'a|b', value: 1 }, { label: 'c', value: 2 }] });
assert.ok(piped.includes('a\\|b'), 'pipe characters in labels are escaped');

// ─── 5) Formatters ──────────────────────────────────────────────────────────
assert.equal(formatCompactValue(32860000), '32.86M');
assert.equal(formatCompactValue(1500), '1.5k');
assert.equal(formatCompactValue(42), '42');
assert.equal(formatCompactValue(-2500000), '-2.50M');
assert.equal(formatFullValue(32860000), '32,860,000');
assert.equal(escapeXml(`<b>&"'`), '&lt;b&gt;&amp;&quot;&apos;');

console.log('chart checks passed ✔');
process.exit(0);
