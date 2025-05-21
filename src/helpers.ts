import axios, { AxiosResponse } from 'axios';
import {
  CONSOLIDATIONS_LIMIT,
  NULL_ADDRESS,
  NULL_ADDRESS_DEAD,
  WALLET_REGEX
} from './constants';
import * as short from 'short-uuid';
import { goerli, sepolia } from '@wagmi/chains';
import { Network } from 'alchemy-sdk';
import moment from 'moment-timezone';

export function areEqualAddresses(w1: string, w2: string) {
  if (!w1 || !w2) {
    return false;
  }
  return w1.toUpperCase() === w2.toUpperCase();
}

export function isNullAddress(address: string) {
  return (
    areEqualAddresses(address, NULL_ADDRESS) ||
    areEqualAddresses(address, NULL_ADDRESS_DEAD)
  );
}

export function getDaysDiff(t1: Date, t2: Date, floor = true) {
  const diff = t1.getTime() - t2.getTime();
  if (floor) {
    return Math.floor(diff / (1000 * 3600 * 24));
  }
  return Math.ceil(diff / (1000 * 3600 * 24));
}

export function getLastTDH() {
  const now = new Date();

  let tdh = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );

  if (tdh > now) {
    tdh = new Date(tdh.getTime() - 24 * 60 * 60 * 1000);
  }

  const tdhStr = moment(tdh).tz('UTC').format('YYYY-MM-DD HH:mm:ss');
  return parseUTCDateString(tdhStr);
}

export const parseUTCDateString = (dateString: any): Date => {
  const parsedDate = moment.tz(dateString, 'YYYY-MM-DD HH:mm:ss', 'UTC');
  return parsedDate.toDate();
};

export function delay(time: number) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

export function formatAddress(address: string) {
  if (!address || !address.startsWith('0x') || address.endsWith('.eth')) {
    return address;
  }
  return `${address.substring(0, 5)}...${address.substring(
    address.length - 3
  )}`;
}

function shouldAddConsolidation(
  uniqueWallets: any[],
  consolidations: any[],
  wallet: string
) {
  let hasConsolidationsWithAll = true;
  uniqueWallets.forEach((w) => {
    if (
      !consolidations.some(
        (c) =>
          (areEqualAddresses(c.wallet1, w) &&
            areEqualAddresses(c.wallet2, wallet)) ||
          (areEqualAddresses(c.wallet2, w) &&
            areEqualAddresses(c.wallet1, wallet))
      )
    ) {
      hasConsolidationsWithAll = false;
    }
  });
  return hasConsolidationsWithAll;
}

export function extractConsolidationWallets(
  consolidations: any[],
  wallet: string
) {
  const uniqueWallets: string[] = [];
  const seenWallets = new Set();

  consolidations.forEach((consolidation) => {
    if (!seenWallets.has(consolidation.wallet1)) {
      seenWallets.add(consolidation.wallet1);
      const shouldAdd = shouldAddConsolidation(
        uniqueWallets,
        consolidations,
        consolidation.wallet1
      );
      if (shouldAdd) {
        uniqueWallets.push(consolidation.wallet1);
        if (uniqueWallets.length === CONSOLIDATIONS_LIMIT) return;
      }
    }
    if (!seenWallets.has(consolidation.wallet2)) {
      seenWallets.add(consolidation.wallet2);
      const shouldAdd = shouldAddConsolidation(
        uniqueWallets,
        consolidations,
        consolidation.wallet2
      );
      if (shouldAdd) {
        uniqueWallets.push(consolidation.wallet2);
        if (uniqueWallets.length === CONSOLIDATIONS_LIMIT) return;
      }
    }
  });

  if (uniqueWallets.some((w) => areEqualAddresses(w, wallet))) {
    return uniqueWallets.sort();
  }

  return [wallet];
}

export function isNumber(s: string) {
  return !isNaN(Number(s));
}

export async function getContentType(url: string): Promise<string | null> {
  try {
    const response: AxiosResponse = await axios.head(
      parseIpfsUrlToCloudflare(url)
    );
    const cType = response.headers['content-type'];
    if (cType) {
      return cType.split('/')[1].toLowerCase();
    }
    return null;
  } catch (error) {
    try {
      const response: AxiosResponse = await axios.head(parseIpfsUrl(url));
      const cType = response.headers['content-type'];
      if (cType) {
        return cType.split('/')[1].toLowerCase();
      }
      return null;
    } catch (error) {
      return null;
    }
  }
}

export function parseIpfsUrl(url: string) {
  if (!url) {
    return url;
  }
  if (url.startsWith('ipfs')) {
    return `https://ipfs.io/ipfs/${url.split('://')[1]}`;
  }
  return url;
}

export function parseIpfsUrlToCloudflare(url: string | undefined) {
  if (!url) {
    return '';
  }
  if (url.startsWith('ipfs')) {
    return `https://cf-ipfs.com/ipfs/${url.split('://')[1]}`;
  }
  return url;
}

export function padTo2Digits(num: number) {
  return num.toString().padStart(2, '0');
}

export function formatDateAsString(date: Date) {
  return [
    date.getFullYear(),
    padTo2Digits(date.getMonth() + 1),
    padTo2Digits(date.getDate())
  ].join('');
}

export function stringToHex(s: string) {
  let hexString = '';
  for (let i = 0; i < s.length; i++) {
    const hex = s.charCodeAt(i).toString(16);
    hexString += hex;
  }
  return hexString;
}

export function distinct<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function uniqueShortId(): string {
  return short.generate();
}

export const sum = (ns: number[]) => ns.reduce((sum, n) => sum + n, 0);

// The assertUnreachable function takes an input _x of type never and always throws
// an error. This function is typically used in TypeScript to assert exhaustiveness in
// switch-case or if-else constructs, ensuring that all possible cases are handled.
// eslint-disable-next-line
export const assertUnreachable = (_x: never): never => {
  // Throw an error with a message indicating that this function should not be reached.
  // This error should only be thrown if there's a bug in the code or a new case has been
  // introduced without updating the relevant switch-case or if-else constructs.
  throw new Error("Didn't expect to get here");
};

export function buildConsolidationKey(wallets: string[]) {
  const sortedWallets = wallets
    .map((it) => it.toLowerCase())
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .filter((it) => it !== '');
  return sortedWallets.join('-');
}

export function weiToEth(wei: number): number {
  return wei / 1e18;
}

export function getRpcUrlFromNetwork(network: Network) {
  return `https://${network.toLowerCase()}.g.alchemy.com/v2/${
    process.env.ALCHEMY_API_KEY
  }`;
}

export function getRpcUrl(chainId: number) {
  let network: Network;

  if (chainId === goerli.id) {
    network = Network.ETH_GOERLI;
  } else if (chainId === sepolia.id) {
    network = Network.ETH_SEPOLIA;
  } else {
    network = Network.ETH_MAINNET;
  }

  return getRpcUrlFromNetwork(network);
}

export function capitalizeEveryWord(input: string): string {
  return input
    .toLocaleLowerCase()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function replaceEmojisWithHex(inputString: string) {
  return inputString.replace(
    /[\uD83C-\uDBFF][\uDC00-\uDFFF]/g,
    (match: string) => {
      const codePoint = match.codePointAt(0);
      if (codePoint) {
        const emojiHex = codePoint.toString(16).toUpperCase();
        return `U+${emojiHex}`;
      }
      return match;
    }
  );
}
/**
 * Split an array into batches of at most `size` items.
 * Fractional sizes are floored.
 * Throws a RangeError when size <= 0.
 */

export function batchArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    throw new RangeError('size must be greater than 0');
  }

  const batchSize = Math.floor(size);
  const batched: T[][] = [];

  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    batched.push(batch);
  }

  return batched;
}

const INT_LIKE = /^[+-]?(?:0|[1-9]\d*)(?:\.0+)?$/;

export function parseIntOrNull(value: any): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isInteger(value) ? value : null;
  }

  // anything that isn’t a string is automatically rejected
  if (typeof value !== 'string') return null;

  // trim *all* whitespace (including NBSP, tabs, new lines…)
  const trimmed = value.trim();

  // string must match the regexp exactly
  if (!INT_LIKE.test(trimmed)) return null;

  // safe to convert – it’s an exact int
  return Number(trimmed);
}

export function resolveEnum<T extends object>(
  enumObj: T,
  value?: string
): T[keyof T] | undefined {
  const normalizedValue = value?.toLowerCase();

  for (const enumKey of Object.keys(enumObj)) {
    // Use type assertion to assure TypeScript that toString can be called
    const enumValue = enumObj[enumKey as keyof T] as any;

    if (enumValue.toString().toLowerCase() === normalizedValue) {
      return enumObj[enumKey as keyof T];
    }
  }

  return undefined;
}

export function resolveEnumOrThrow<T extends object>(
  enumObj: T,
  value?: string
): T[keyof T] {
  const resolvedValue = resolveEnum(enumObj, value);
  if (resolvedValue) {
    return resolvedValue;
  }
  throw new Error(`Invalid enum value: ${value}`);
}

export function getTransactionLink(chain_id: number, hash: string) {
  switch (chain_id) {
    case sepolia.id:
      return `https://sepolia.etherscan.io/tx/${hash}`;
    case goerli.id:
      return `https://goerli.etherscan.io/tx/${hash}`;
    default:
      return `https://etherscan.io/tx/${hash}`;
  }
}

export function isWallet(identity: string) {
  return WALLET_REGEX.test(identity);
}
