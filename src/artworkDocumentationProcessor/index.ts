import { artworkAssetsProcessor } from '@/artwork-documentation/assets/artwork-assets.processor';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import { publishArtworkAssetMetrics } from '@/artwork-documentation/assets/artwork-assets.metrics';
import { dispatchDocumentationProcessorEvent } from './artwork-documentation-operator';

const logger = Logger.get('ARTWORK_DOCUMENTATION_PROCESSOR');
export const handler = sentryContext.wrapLambdaHandler(
  async (event: unknown) => {
    return doInDbContext(
      () =>
        dispatchDocumentationProcessorEvent(event, async () => {
          await artworkAssetsProcessor.tick();
          try {
            await publishArtworkAssetMetrics();
          } catch {
            logger.warn('Archive operational metrics could not be published');
          }
        }),
      { logger }
    );
  }
);
