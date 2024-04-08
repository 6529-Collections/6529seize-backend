import axios from 'axios';
import { getEthPriceCount, persistEthPrices } from './db.eth_price';
import { Logger } from '../logging';
import { EthPrice } from '../entities/IEthPrice';
import { Time } from '../time';

const MOBULA_HISTORIC_URL =
  'https://api.mobula.io/api/1/market/history?asset=Ethereum&from=1633046400000';

const MOBULA_CURRENT_URL =
  'https://api.mobula.io/api/1/market/data?asset=Ethereum';

interface HistoricResponse {
  data: {
    price_history: [number, number][];
  };
}

interface CurrentResponse {
  data: {
    price: number;
  };
}

const logger = Logger.get('ETH_PRICE');

export async function syncEthUsdPrice(reset: boolean) {
  const existingData = await getEthPriceCount();
  const isReset = reset || existingData === 0;

  if (isReset) {
    logger.info('[RESET] : [FETCHING HISTORIC DATA]');
    await syncHistoricEthUsdPriceData();
  } else {
    logger.info('[FETCHING NEW DATA]');
    await syncLatestEthUsdPriceData();
  }
}

async function syncHistoricEthUsdPriceData() {
  const historicResponse = await axios.get<HistoricResponse>(
    MOBULA_HISTORIC_URL
  );
  const historicData = historicResponse.data;
  logger.info(
    `[HISTORIC DATA  RESPONSE ${historicData.data.price_history.length}]`
  );
  const ethPrices: EthPrice[] = historicData.data.price_history.map(
    ([timestamp, price]) => {
      return {
        timestamp_ms: timestamp,
        date: Time.millis(timestamp).toDate(),
        usd_price: price
      };
    }
  );
  await persistEthPrices(ethPrices);
  logger.info(`[HISTORIC DATA PERSISTED] : [${ethPrices.length}]`);
}

async function syncLatestEthUsdPriceData() {
  const currentResponse = await axios.get<CurrentResponse>(MOBULA_CURRENT_URL);
  const currentData = currentResponse.data;
  logger.info(`[CURRENT DATA RESPONSE]`);
  const ethPrice: EthPrice = {
    timestamp_ms: Time.now().toMillis(),
    date: Time.now().toDate(),
    usd_price: currentData.data.price
  };
  await persistEthPrices([ethPrice]);
  logger.info(`[CURRENT DATA PERSISTED] : [${ethPrice.usd_price}]`);
}
