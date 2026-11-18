/**
 * Deterministic Chart Generator
 * ════════════════════════════════════════════════════════════════════════════
 * Turns a validated (label, value) series into an SVG bar chart + markdown table.
 * No LLM calls, no network — safe to unit-test. The LLM is used upstream (see
 * flows/chart.ts) ONLY to propose the series; everything rendered here is
 * derived from the numbers, so the chart can never disagree with the table.
 */

import { z } from 'zod';

export interface ChartItem {
  label: string;
  value: number;
}

export interface ChartSpec {
  title: string;
  unit?: string;
  note?: string;
  items: ChartItem[];
}

// ─── XML escaping (labels/titles are LLM output — never trust them raw) ─────

export function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── LLM output parsing & validation ─────────────────────────────────────────

const ItemSchema = z.object({
  label: z.string().trim().min(1).max(80),
  value: z.number().finite(),
});

const SpecSchema = z.object({
  title: z.string().trim().min(1).max(140).catch('Chart'),
  unit: z.string().trim().max(60).optional(),
  note: z.string().trim().max(240).optional(),
  items: z.array(ItemSchema).min(2).max(12),
});

/** Compact a value for axis/bar labels: 32,860,000 → "32.86M" */
export function formatCompactValue(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}k`;
  return `${sign}${Number.isInteger(abs) ? abs : abs.toFixed(2)}`;
}

/** Full value with thousands separators for the markdown table. */
export function formatFullValue(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
  return rounded.toLocaleString('en-US');
}

/**
 * Parse the LLM's chart spec out of its raw response.
 * Tolerates ```json fences and leading/trailing prose; returns null on garbage.
 */
export function parseChartJson(raw: string): ChartSpec | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
  if (!candidate || !candidate.includes('items')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  const result = SpecSchema.safeParse(parsed);
  if (!result.success) return null;

  const items = result.data.items
    .map(item => ({ label: item.label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim(), value: item.value }))
    .filter(item => item.label.length > 0 && Number.isFinite(item.value))
    .slice(0, 8);

  if (items.length < 2) return null;

  return {
    title: result.data.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'Chart',
    unit: result.data.unit?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || undefined,
    note: result.data.note?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || undefined,
    items,
  };
}

// ─── Markdown table ──────────────────────────────────────────────────────────

export function specToMarkdownTable(spec: ChartSpec): string {
  const unitSuffix = spec.unit ? ` (${spec.unit})` : '';
  const rows = spec.items.map((item, index) =>
    `| ${index + 1} | ${item.label.replace(/\|/g, '\\|')} | ${formatFullValue(item.value)} |`
  );
  return [
    `| # | Item | Value${unitSuffix} |`,
    '|---|------|--------|',
    ...rows,
  ].join('\n');
}

// ─── SVG bar chart ───────────────────────────────────────────────────────────

const WIDTH = 920;
const LABEL_X = 24;
const LABEL_WIDTH = 250;
const BAR_X = 286;
const VALUE_WIDTH = 96;
const BAR_MAX_WIDTH = WIDTH - BAR_X - VALUE_WIDTH - 24;
const ROW_HEIGHT = 46;
const BAR_HEIGHT = 22;
const TOP_HEIGHT = 84;
const BOTTOM_HEIGHT = 48;

function truncate(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

export function renderBarChartSvg(spec: ChartSpec): string {
  const items = spec.items;
  const maxValue = Math.max(...items.map(item => Math.abs(item.value)), 1);
  const height = TOP_HEIGHT + items.length * ROW_HEIGHT + BOTTOM_HEIGHT;

  const bars = items.map((item, index) => {
    const y = TOP_HEIGHT + index * ROW_HEIGHT;
    const barLength = Math.max(2, (Math.abs(item.value) / maxValue) * BAR_MAX_WIDTH);
    const valueLabel = formatCompactValue(item.value);
    return `
  <text x="${LABEL_X}" y="${y + BAR_HEIGHT - 5}" font-size="14" fill="#1f2937" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">${escapeXml(truncate(item.label, 30))}</text>
  <rect x="${BAR_X}" y="${y}" width="${barLength.toFixed(1)}" height="${BAR_HEIGHT}" rx="5" fill="url(#barGradient)"/>
  <text x="${(BAR_X + barLength + 10).toFixed(1)}" y="${y + BAR_HEIGHT - 6}" font-size="13" font-weight="600" fill="#111827" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">${escapeXml(valueLabel)}</text>`;
  }).join('');

  const subtitle = spec.unit ? escapeXml(`Unit: ${spec.unit}`) : '';
  const note = spec.note ? `<text x="${LABEL_X}" y="${height - 16}" font-size="11" fill="#64748b" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">${escapeXml(truncate(spec.note, 110))}</text>` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeXml(spec.title)}">
  <defs>
    <linearGradient id="barGradient" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${WIDTH}" height="${height}" rx="14" fill="#ffffff" stroke="#e2e8f0"/>
  <text x="${LABEL_X}" y="36" font-size="21" font-weight="700" fill="#0f172a" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">${escapeXml(truncate(spec.title, 70))}</text>
  <text x="${LABEL_X}" y="60" font-size="12" fill="#64748b" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">${subtitle}</text>
  <line x1="${BAR_X}" y1="${TOP_HEIGHT - 10}" x2="${BAR_X}" y2="${height - BOTTOM_HEIGHT + 6}" stroke="#e2e8f0" stroke-width="2"/>${bars}
  ${note}
</svg>`;
}

export function specToSvgDataUri(spec: ChartSpec): string {
  const svg = renderBarChartSvg(spec);
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
