import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import axiosRetry from 'axios-retry';
import { EthPrice } from '../entities/IEthPrice';
import { Logger } from '../logging';
import { Time } from '../time';
import { getEthPriceCount, persistEthPrices } from './db.eth_price';

const MOBULA_HISTORIC_URL =
  'https://api.mobula.io/api/1/market/history?asset=Ethereum&from=1633046400000';

const MOBULA_CURRENT_URL =
  'https://api.mobula.io/api/1/market/data?asset=Ethereum';

const MOBULA_RETRIES = 3;
const MAX_RETRY_AFTER_MS = Time.seconds(30).toMillis();

const mobulaAxios = axios.create();

axiosRetry(mobulaAxios, {
  retries: MOBULA_RETRIES,
  retryDelay: getRetryDelay,
  retryCondition: isRetryableMobulaError,
  shouldResetTimeout: true
});

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

function normalizeHeaderValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return normalizeHeaderValue(value[0]);
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    return value.toString();
  }

  return undefined;
}

function getRetryAfterHeader(error: AxiosError): string | undefined {
  const headers = error.response?.headers;
  if (!headers) {
    return undefined;
  }

  if ('get' in headers && typeof headers.get === 'function') {
    return normalizeHeaderValue(headers.get('retry-after'));
  }

  const headerRecord = headers as Record<string, unknown>;
  return normalizeHeaderValue(
    headerRecord['retry-after'] ?? headerRecord['Retry-After']
  );
}

function getRetryAfterMs(error: AxiosError): number | undefined {
  const retryAfterHeader = getRetryAfterHeader(error);
  if (!retryAfterHeader) {
    return undefined;
  }

  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * Time.seconds(1).toMillis();
  }

  const retryAt = Date.parse(retryAfterHeader);
  if (!Number.isFinite(retryAt)) {
    return undefined;
  }

  return Math.max(0, retryAt - Date.now());
}

function isShortRateLimitRetry(error: AxiosError): boolean {
  const retryAfterMs = getRetryAfterMs(error);
  return retryAfterMs === undefined || retryAfterMs <= MAX_RETRY_AFTER_MS;
}

function isRateLimitError(error: unknown): error is AxiosError {
  return axios.isAxiosError(error) && error.response?.status === 429;
}

function isRetryableMobulaError(error: AxiosError): boolean {
  const status = error.response?.status ?? 0;
  if (status === 429) {
    return isShortRateLimitRetry(error);
  }

  return (
    axiosRetry.isNetworkError(error) ||
    axiosRetry.isRetryableError(error) ||
    status >= 500
  );
}

function getRetryDelay(retryCount: number, error: AxiosError): number {
  if (error.response?.status === 429) {
    const retryAfterMs = getRetryAfterMs(error);
    if (retryAfterMs !== undefined && retryAfterMs <= MAX_RETRY_AFTER_MS) {
      return retryAfterMs;
    }
  }

  return axiosRetry.exponentialDelay(retryCount, error);
}

function getRetryAfterLogValue(error: AxiosError): number {
  return getRetryAfterMs(error) ?? -1;
}

async function fetchMobulaData<T>(
  url: string,
  label: 'CURRENT' | 'HISTORIC',
  config?: AxiosRequestConfig
): Promise<T | undefined> {
  try {
    const response = await mobulaAxios.get<T>(url, config);
    return response.data;
  } catch (error) {
    if (isRateLimitError(error)) {
      logger.warn(
        `[${label} DATA SKIPPED] : [MOBULA HTTP 429] [RETRY_AFTER_MS ${getRetryAfterLogValue(
          error
        )}]`
      );
      return undefined;
    }

    throw error;
  }
}

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
  const historicData = await fetchMobulaData<HistoricResponse>(
    MOBULA_HISTORIC_URL,
    'HISTORIC'
  );
  if (!historicData) {
    return;
  }
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
  const apiKey = process.env.MOBULA_API_KEY;
  const currentData = await fetchMobulaData<CurrentResponse>(
    MOBULA_CURRENT_URL,
    'CURRENT',
    {
      headers: apiKey
        ? {
            Authorization: `Bearer ${apiKey}`
          }
        : undefined
    }
  );
  if (!currentData) {
    return;
  }
  logger.info(`[CURRENT DATA RESPONSE]`);
  const ethPrice: EthPrice = {
    timestamp_ms: Time.now().toMillis(),
    date: Time.now().toDate(),
    usd_price: currentData.data.price
  };
  await persistEthPrices([ethPrice]);
  logger.info(`[CURRENT DATA PERSISTED] : [${ethPrice.usd_price}]`);
}
