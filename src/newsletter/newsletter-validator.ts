import { NewsletterWindow } from './newsletter.config';
import {
  NewsletterOutput,
  NewsletterParagraph
} from './newsletter-output.schema';
import { SourceRecord, SourceRegistry } from './newsletter-sources';

const MAX_REASONS = 50;

// A URL, bare domain reference, Markdown link or autolink anywhere in prose.
// Bounded quantifiers keep matching linear on hostile input.
const LINK_PATTERNS: readonly RegExp[] = [
  /https?:\/\//i,
  /\bwww\.[a-z0-9-]{1,100}\./i,
  /\b6529\.io\b/i,
  /\]\(/,
  /\]\[/,
  /<[^>\s]{1,500}:\/\/[^>\s]{0,1000}>/,
  /\b[a-z0-9-]{1,63}\.(?:io|com|net|org|xyz|eth|app|dev)\/[^\s]{1,500}/i
];

export class NewsletterValidationError extends Error {
  constructor(public readonly reasons: readonly string[]) {
    super(`Newsletter output failed validation: ${reasons.join('; ')}`);
    this.name = 'NewsletterValidationError';
    Object.setPrototypeOf(this, NewsletterValidationError.prototype);
  }
}

export function containsLink(text: string): boolean {
  return LINK_PATTERNS.some((pattern) => pattern.test(text));
}

function inWindow(record: SourceRecord, window: NewsletterWindow): boolean {
  const time = Date.parse(record.time);
  return time >= window.start && time < window.end;
}

function checkParagraph(
  paragraph: NewsletterParagraph,
  where: string,
  registry: SourceRegistry,
  window: NewsletterWindow,
  reasons: string[]
): void {
  if (containsLink(paragraph.text)) {
    reasons.push(`${where}: text contains a URL or Markdown link`);
  }
  if (!paragraph.citations.length) {
    reasons.push(`${where}: paragraph cites no source`);
  }
  for (const id of paragraph.citations) {
    const record = registry.get(id);
    if (!record) {
      reasons.push(`${where}: unknown source id "${id}"`);
    } else if (!record.context_only && !inWindow(record, window)) {
      reasons.push(
        `${where}: source "${id}" at ${record.time} is outside the reporting window`
      );
    }
  }
}

function checkCoverage(
  kind: 'WINNER' | 'MINT',
  covered: readonly string[],
  cited: ReadonlySet<string>,
  registry: SourceRegistry,
  reasons: string[]
): void {
  const label = kind === 'WINNER' ? 'winners_covered' : 'mints_covered';
  for (const id of covered) {
    const record = registry.get(id);
    if (!record) reasons.push(`${label}: unknown source id "${id}"`);
    else if (record.kind !== kind) {
      reasons.push(`${label}: "${id}" is a ${record.kind} source`);
    } else if (!cited.has(id)) {
      reasons.push(`${label}: "${id}" is listed but no paragraph cites it`);
    }
  }
  const coveredSet = new Set(covered);
  for (const record of Array.from(registry.values())) {
    if (record.kind === kind && !coveredSet.has(record.source_id)) {
      reasons.push(
        `${label}: required ${kind} "${record.source_id}" is missing`
      );
    }
  }
}

/**
 * Returns every reason the output must not be published. An empty list means
 * the prose cites only registry records, contains no links of its own, and
 * reports only events inside the window (plus explicitly marked context).
 */
export function validateNewsletterOutput(
  output: NewsletterOutput,
  registry: SourceRegistry,
  window: NewsletterWindow
): string[] {
  const reasons: string[] = [];
  const cited = new Set<string>();
  output.sections.forEach((section, s) => {
    const sectionWhere = `section ${s + 1} "${section.heading.slice(0, 60)}"`;
    if (containsLink(section.heading)) {
      reasons.push(`${sectionWhere}: heading contains a URL or Markdown link`);
    }
    section.paragraphs.forEach((paragraph, p) => {
      paragraph.citations.forEach((id) => cited.add(id));
      checkParagraph(
        paragraph,
        `${sectionWhere} paragraph ${p + 1}`,
        registry,
        window,
        reasons
      );
    });
  });
  checkCoverage('WINNER', output.winners_covered, cited, registry, reasons);
  checkCoverage('MINT', output.mints_covered, cited, registry, reasons);
  return reasons.slice(0, MAX_REASONS);
}

function escapeMarkdown(text: string): string {
  // Model prose may not carry link syntax; neutralize brackets and angle
  // brackets so nothing in it can become a link or HTML once rendered.
  return text.replace(/[[\]<>]/g, (character) => `\\${character}`);
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/** Source labels use registry fields only: never names or dates from prose. */
export function sourceLabel(record: SourceRecord): string {
  const by = record.author_handle ? ` by ${record.author_handle}` : '';
  switch (record.kind) {
    case 'DROP': {
      const title = record.title ? `"${record.title}"` : 'message';
      const where = record.wave_name ? ` in ${record.wave_name}` : '';
      return `${title}${by}${where}, ${day(record.time)}`;
    }
    case 'WINNER': {
      const title = record.title ? `"${record.title}"` : 'submission';
      return `Main Stage winner ${title}${by}, ${day(record.time)}`;
    }
    case 'MINT': {
      const title = record.title ? ` "${record.title}"` : '';
      return `${record.canonical_url.includes('/meme-lab/') ? 'Meme Lab' : 'The Memes'} #${record.source_id.split(':').pop()}${title}`;
    }
    case 'IDENTITY':
      return `@${record.author_handle ?? record.title ?? 'profile'}`;
  }
}

function sourceLine(
  citations: readonly string[],
  registry: SourceRegistry
): string {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const id of citations) {
    const record = registry.get(id);
    if (!record || seen.has(id)) continue;
    seen.add(id);
    links.push(
      `[${escapeMarkdown(sourceLabel(record))}](${record.canonical_url})`
    );
  }
  return `Sources: ${links.join(' · ')}`;
}

/**
 * Renders validated output as Markdown. Every link comes from the registry;
 * the function throws rather than render output that fails validation.
 */
export function renderNewsletter(
  output: NewsletterOutput,
  registry: SourceRegistry,
  window: NewsletterWindow
): string {
  const reasons = validateNewsletterOutput(output, registry, window);
  if (reasons.length) throw new NewsletterValidationError(reasons);
  const blocks: string[] = [];
  for (const section of output.sections) {
    blocks.push(`### ${escapeMarkdown(section.heading)}`);
    for (const paragraph of section.paragraphs) {
      blocks.push(
        `${escapeMarkdown(paragraph.text)}\n\n*${sourceLine(paragraph.citations, registry)}*`
      );
    }
  }
  return blocks.join('\n\n');
}
