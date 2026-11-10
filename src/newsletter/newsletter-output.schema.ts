import { z } from 'zod';
import { SOURCE_ID_PATTERN } from './newsletter-sources';

const MAX_HEADING_LENGTH = 200;
const MAX_PARAGRAPH_LENGTH = 4_000;
const MAX_CITATIONS_PER_PARAGRAPH = 25;
const MAX_PARAGRAPHS_PER_SECTION = 40;
const MAX_SECTIONS = 40;
const MAX_COVERED = 500;

const sourceIdSchema = z.string().regex(SOURCE_ID_PATTERN, 'invalid source id');

const paragraphSchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_PARAGRAPH_LENGTH),
    citations: z.array(sourceIdSchema).max(MAX_CITATIONS_PER_PARAGRAPH)
  })
  .strict();

const sectionSchema = z
  .object({
    heading: z.string().trim().min(1).max(MAX_HEADING_LENGTH),
    paragraphs: z.array(paragraphSchema).min(1).max(MAX_PARAGRAPHS_PER_SECTION)
  })
  .strict();

/**
 * The writer's output contract. Prose carries citations by source id only;
 * the backend renders every link, date, name and count from the registry.
 */
export const newsletterOutputSchema = z
  .object({
    sections: z.array(sectionSchema).min(1).max(MAX_SECTIONS),
    winners_covered: z.array(sourceIdSchema).max(MAX_COVERED),
    mints_covered: z.array(sourceIdSchema).max(MAX_COVERED)
  })
  .strict();

export type NewsletterOutput = z.infer<typeof newsletterOutputSchema>;
export type NewsletterSection = NewsletterOutput['sections'][number];
export type NewsletterParagraph = NewsletterSection['paragraphs'][number];

export class NewsletterOutputError extends Error {
  constructor(
    message: string,
    public readonly reasons: readonly string[]
  ) {
    super(message);
    this.name = 'NewsletterOutputError';
    Object.setPrototypeOf(this, NewsletterOutputError.prototype);
  }
}

/** Accepts a bare JSON document or one wrapped in a single Markdown code fence. */
export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

export function parseNewsletterOutput(raw: string): NewsletterOutput {
  let candidate: unknown;
  try {
    candidate = JSON.parse(stripCodeFence(raw));
  } catch (error) {
    throw new NewsletterOutputError('Newsletter output is not JSON', [
      `malformed output: ${error instanceof Error ? error.message : 'not JSON'}`
    ]);
  }
  const result = newsletterOutputSchema.safeParse(candidate);
  if (!result.success) {
    const reasons = result.error.issues
      .slice(0, 20)
      .map(
        (issue) =>
          `unsupported output at ${issue.path.join('.') || '$'}: ${issue.message}`
      );
    throw new NewsletterOutputError(
      'Newsletter output does not match the contract',
      reasons
    );
  }
  return result.data;
}
