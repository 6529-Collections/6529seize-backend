import { randomUUID } from 'node:crypto';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { NewsletterCollector } from './newsletter-collector';
import { NewsletterConfig, NewsletterWindow } from './newsletter.config';
import { NewsletterDb, newsletterDb } from './newsletter.db';
import {
  NewsletterPublisher,
  newsletterMarkdown
} from './newsletter-publisher';
import { NewsletterWriter } from './newsletter-writer';

const logger = Logger.get('NEWSLETTER');

export async function publishNewsletter(
  config: NewsletterConfig,
  window: NewsletterWindow,
  ctx: RequestContext,
  dependencies: {
    db: Pick<NewsletterDb, 'publishedEdition'>;
    collector: Pick<NewsletterCollector, 'collect'>;
    writer: Pick<NewsletterWriter, 'write'>;
    publisher: Pick<NewsletterPublisher, 'authorId' | 'publish'>;
  } = {
    db: newsletterDb,
    collector: new NewsletterCollector(newsletterDb),
    writer: new NewsletterWriter(config.modelId),
    publisher: new NewsletterPublisher(config.wallet)
  }
): Promise<{ status: string; dropId?: string }> {
  const { db, collector, writer, publisher } = dependencies;
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
  }
  const material = await collector.collect(
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
    mints: material.mints.length
  });
  if (
    !material.sources.length &&
    !material.winners.length &&
    !material.mints.length
  ) {
    return { status: 'no-public-activity' };
  }
  const body = await writer.write(material);
  const dropId = await publisher.publish(
    config.waveId,
    editionId,
    newsletterMarkdown(body, window),
    window
  );
  logger.info('Published newsletter', { dropId, editionId });
  return { status: 'published', dropId };
}
