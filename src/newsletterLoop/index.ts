import { prepEnvironment } from '@/env';
import { Logger } from '@/logging';
import {
  newsletterWindow,
  readNewsletterConfig
} from '@/newsletter/newsletter.config';
import { publishNewsletter } from '@/newsletter/newsletter.service';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import { Timer } from '@/time';

const logger = Logger.get('NEWSLETTER_LOOP');

export async function runNewsletter(
  event: unknown
): Promise<{ status: string; dropId?: string }> {
  // Capture the deployment stage before shared mutable secrets are loaded.
  if (process.env.NEWSLETTER_STAGE !== 'prod')
    return { status: 'not-production' };
  const invokedAt = Date.now();
  await prepEnvironment();
  const config = readNewsletterConfig();
  if (!config) {
    logger.info(
      'Newsletter is disabled: publisher configuration is incomplete'
    );
    return { status: 'not-configured' };
  }
  const window = newsletterWindow(event, invokedAt);
  return doInDbContext(
    () =>
      publishNewsletter(config, window, {
        timer: new Timer('NEWSLETTER_LOOP')
      }),
    { logger, skipRedis: true }
  );
}

export const handler = sentryContext.wrapLambdaHandler(runNewsletter);
