import { syncEthUsdPrice } from './eth_usd_price';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { Time } from '../time';
import { EthPrice } from '../entities/IEthPrice';

const logger = Logger.get('ETH_PRICE_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  const start = Time.now();
  logger.info('[RUNNING]');
  await loadEnv([EthPrice]);
  const reset = process.env.ETH_PRICE_RESET == 'true';
  await syncEthUsdPrice(reset);
  await unload();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
});
