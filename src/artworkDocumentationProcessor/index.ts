import { withMediaDependencySmoke } from '@/media/media-dependency-smoke';
import { artworkAssetsProcessor } from '@/artwork-documentation/assets/artwork-assets.processor';
import { dossierProcessor } from '@/artwork-documentation/museum/export/dossier.processor';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import { publishArtworkAssetMetrics } from '@/artwork-documentation/assets/artwork-assets.metrics';
import { processOldestDocumentationJob } from './artwork-documentation-queue';
import {
  dispatchDocumentationProcessorEvent,
  enrichDocumentationOperatorError
} from './artwork-documentation-operator';

const logger = Logger.get('ARTWORK_DOCUMENTATION_PROCESSOR');
const liveHandler = sentryContext.wrapLambdaHandler(
  async (event: unknown) => {
    return doInDbContext(
      () =>
        dispatchDocumentationProcessorEvent(event, async () => {
          await processOldestDocumentationJob({
            asset: artworkAssetsProcessor,
            dossier: dossierProcessor
          });
          try {
            await publishArtworkAssetMetrics();
          } catch {
            logger.warn('Archive operational metrics could not be published');
          }
        }),
      { logger }
    );
  },
  { enrichEvent: enrichDocumentationOperatorError }
);

export const handler = withMediaDependencySmoke(liveHandler);
