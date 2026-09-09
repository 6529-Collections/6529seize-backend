import { artworkAssetsProcessor } from '@/artwork-documentation/assets/artwork-assets.processor';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';

const logger = Logger.get('ARTWORK_DOCUMENTATION_PROCESSOR');
export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(() => artworkAssetsProcessor.tick(), { logger });
});
