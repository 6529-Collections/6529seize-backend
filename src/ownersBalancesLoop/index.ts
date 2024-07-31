import { updateOwnerBalances } from './owners_balances';
import { Logger } from '../logging';
import {
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes,
  OwnerBalances,
  OwnerBalancesMemes
} from '../entities/IOwnerBalances';
import * as sentryContext from '../sentry.context';
import { MemesSeason } from '../entities/ISeason';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import { doInDbContext } from '../secrets';

const logger = Logger.get('OWNER_BALANCES_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await updateOwnerBalances(process.env.OWNER_BALANCES_RESET == 'true');
    },
    {
      logger,
      entities: [
        MemesSeason,
        NFTOwner,
        ConsolidatedNFTOwner,
        OwnerBalances,
        ConsolidatedOwnerBalances,
        OwnerBalancesMemes,
        ConsolidatedOwnerBalancesMemes
      ]
    }
  );
});
