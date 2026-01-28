import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { NFTOwner } from '../entities/INFTOwner';
import {
  NextGenCollection,
  NextGenToken,
  NextGenTokenScore,
  NextGenTokenTrait
} from '../entities/INextGen';
import { refreshNextgenMetadata } from '../nextgen/nextgen_metadata_refresh';
import { doInDbContext } from '../secrets';

const logger = Logger.get('NEXTGEN_METADATA_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await refreshNextgenMetadata();
    },
    {
      entities: [
        NFTOwner,
        NextGenCollection,
        NextGenToken,
        NextGenTokenTrait,
        NextGenTokenScore
      ],
      logger
    }
  );
});
