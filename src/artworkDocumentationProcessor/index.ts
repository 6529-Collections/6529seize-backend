import { withMediaDependencySmoke } from '@/media/media-dependency-smoke';
import { artworkAssetsProcessor } from '@/artwork-documentation/assets/artwork-assets.processor';
import { dossierProcessor } from '@/artwork-documentation/museum/export/dossier.processor';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import { publishArtworkAssetMetrics } from '@/artwork-documentation/assets/artwork-assets.metrics';
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
          // Each queue can use most of one Lambda invocation. Alternate priority
          // without running two long jobs inside the same 900-second budget.
          if (Math.floor(Date.now() / 60000) % 2 === 0) {
            if (!(await dossierProcessor.tick()))
              await artworkAssetsProcessor.tick();
          } else if (!(await artworkAssetsProcessor.tick())) {
            await dossierProcessor.tick();
          }
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
