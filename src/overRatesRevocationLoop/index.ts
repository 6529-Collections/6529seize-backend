import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';
import { waveDecisionsService } from '../waves/wave-decisions.service';
import { Timer } from '../time';

const logger = Logger.get('OVER_RATES_REVOCATION_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const timer = new Timer(`WAVE_DECISION_MAKER_LOOP`);
      await waveDecisionsService.createMissingDecisionsForAllWaves(timer);
      console.log(timer);
    },
    {
      logger
    }
  );
});
