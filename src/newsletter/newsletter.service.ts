import { randomUUID } from 'node:crypto';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { NewsletterEditionStatus } from '@/entities/INewsletterEdition';
import { NewsletterCollector } from './newsletter-collector';
import { NewsletterConfig, NewsletterWindow } from './newsletter.config';
import {
  NewsletterDb,
  NewsletterEditionRecord,
  newsletterDb
} from './newsletter.db';
import {
  NewsletterPublisher,
  newsletterMarkdown
} from './newsletter-publisher';
import { NewsletterWriter } from './newsletter-writer';
import {
  NewsletterOutput,
  NewsletterOutputError,
  parseNewsletterOutput
} from './newsletter-output.schema';
import { SourceRegistry } from './newsletter-sources';
import {
  renderNewsletter,
  validateNewsletterOutput
} from './newsletter-validator';

const logger = Logger.get('NEWSLETTER');

export type NewsletterOutcome =
  | 'published'
  | 'already-published'
  | 'no-public-activity'
  | 'rejected-unverified';

export interface NewsletterResult {
  status: NewsletterOutcome;
  dropId?: string;
  reasons?: string[];
}

interface NewsletterDependencies {
  db: Pick<NewsletterDb, 'publishedEdition' | 'findEdition' | 'saveEdition'>;
  collector: Pick<NewsletterCollector, 'collect'>;
  writer: Pick<NewsletterWriter, 'write'>;
  publisher: Pick<NewsletterPublisher, 'authorId' | 'publish'>;
}

function defaultDependencies(config: NewsletterConfig): NewsletterDependencies {
  return {
    db: newsletterDb,
    collector: new NewsletterCollector(newsletterDb),
    writer: new NewsletterWriter(config.modelId),
    publisher: new NewsletterPublisher(config.wallet)
  };
}

/**
 * Checks the raw model answer against the registry and renders it. Returns
 * either the publishable Markdown body or every reason it must not publish.
 */
export function verifyNewsletter(
  raw: string,
  registry: SourceRegistry,
  window: NewsletterWindow
): { body: string } | { reasons: string[] } {
  let output: NewsletterOutput;
  try {
    output = parseNewsletterOutput(raw);
  } catch (error) {
    if (error instanceof NewsletterOutputError) {
      return { reasons: [...error.reasons] };
    }
    throw error;
  }
  const reasons = validateNewsletterOutput(output, registry, window);
  if (reasons.length) return { reasons };
  try {
    return {
      body: newsletterMarkdown(
        renderNewsletter(output, registry, window),
        window
      )
    };
  } catch (error) {
    return {
      reasons: [
        `rendered edition rejected: ${error instanceof Error ? error.message : 'unknown error'}`
      ]
    };
  }
}

export async function publishNewsletter(
  config: NewsletterConfig,
  window: NewsletterWindow,
  ctx: RequestContext,
  dependencies?: NewsletterDependencies
): Promise<NewsletterResult> {
  const { db, collector, writer, publisher } =
    dependencies ?? defaultDependencies(config);
  const authorId = await publisher.authorId();
  const editionId = window.scheduled
    ? `daily:${new Date(window.start).toISOString().slice(0, 10)}`
    : `manual:${randomUUID()}`;
  if (window.scheduled) {
    const existing = await db.publishedEdition(
      editionId,
      config.waveId,
      authorId,
      ctx
    );
    if (existing) return { status: 'already-published', dropId: existing };
    const edition = await db.findEdition(editionId, ctx);
    if (edition?.status === NewsletterEditionStatus.Published) {
      return {
        status: 'already-published',
        dropId: edition.drop_id ?? undefined
      };
    }
  }
  const { material, registry } = await collector.collect(
    window,
    config.waveId,
    authorId,
    ctx
  );
  logger.info('Collected public newsletter material', {
    start: material.window.start,
    end: material.window.end,
    sources: material.sources.length,
    winners: material.winners.length,
    mints: material.mints.length,
    registry: registry.size
  });
  if (
    !material.sources.length &&
    !material.winners.length &&
    !material.mints.length
  ) {
    return { status: 'no-public-activity' };
  }
  const raw = await writer.write(material);
  const edition: Omit<NewsletterEditionRecord, 'status' | 'drop_id'> = {
    edition_id: editionId,
    window_start: window.start,
    window_end: window.end,
    mode: window.scheduled ? 'scheduled' : 'manual',
    raw_output: raw,
    rejection_reasons: null,
    sources: Array.from(registry.values())
  };
  const verified = verifyNewsletter(raw, registry, window);
  if ('reasons' in verified) {
    await db.saveEdition(
      {
        ...edition,
        status: NewsletterEditionStatus.Rejected,
        drop_id: null,
        rejection_reasons: verified.reasons
      },
      ctx
    );
    logger.warn('Newsletter edition rejected before publication', {
      editionId,
      reasons: verified.reasons.length,
      first: verified.reasons[0]
    });
    return { status: 'rejected-unverified', reasons: verified.reasons };
  }
  const dropId = await publisher.publish(
    config.waveId,
    editionId,
    verified.body,
    window
  );
  await db.saveEdition(
    { ...edition, status: NewsletterEditionStatus.Published, drop_id: dropId },
    ctx
  );
  logger.info('Published newsletter', { dropId, editionId });
  return { status: 'published', dropId };
}
