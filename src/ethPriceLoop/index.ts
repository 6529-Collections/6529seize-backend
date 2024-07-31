import { syncEthUsdPrice } from './eth_usd_price';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { EthPrice } from '../entities/IEthPrice';
import { doInDbContext } from '../secrets';

const logger = Logger.get('ETH_PRICE_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const reset = process.env.ETH_PRICE_RESET == 'true';
      await syncEthUsdPrice(reset);
    },
    { entities: [EthPrice], logger }
  );
});
