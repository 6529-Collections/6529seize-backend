import fetch from 'node-fetch';
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
import { Transaction } from './entities/ITransaction';
import { getAlchemyInstance } from './alchemy';
import * as mcache from 'memory-cache';
import { Time } from './time';
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

export function areEqualObjects(obj1: any, obj2: any) {
  if (obj1 == null || obj2 == null) {
    return false;
  }
  for (const property in obj1) {
    const value1 = obj1[property];
    const value2 = obj2[property];
    if (typeof value1 === 'object' && value1 !== null) {
      if (!areEqualObjects(value1, value2)) {
        return false;
      }
    } else if (value1 != value2) {
      return false;
    }
  }
  return true;
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

export function isValidUrl(url: string) {
  try {
    new URL(url);
    return true;
  } catch (_) {
    return false;
  }
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
export const assertUnreachable = (_x: never): never => {
  // Throw an error with a message indicating that this function should not be reached.
  // This error should only be thrown if there's a bug in the code or a new case has been
  // introduced without updating the relevant switch-case or if-else constructs.
  throw new Error("Didn't expect to get here");
};

export async function fetchImage(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  return await response.arrayBuffer();
}

export async function compareImages(
  url1: string,
  url2: string
): Promise<boolean> {
  try {
    const [image1, image2] = await Promise.all([
      fetchImage(url1),
      fetchImage(url2)
    ]);
    const data1 = new Uint8Array(image1);
    const data2 = new Uint8Array(image2);
    const areImagesEqual = JSON.stringify(data1) === JSON.stringify(data2);
    return areImagesEqual;
  } catch (error) {
    console.error('Error fetching or comparing images:', error);
    return false;
  }
}

export function buildConsolidationKey(wallets: string[]) {
  const sortedWallets = wallets
    .map((it) => it.toLowerCase())
    .slice()
    .sort((a, b) => a.localeCompare(b));
  return sortedWallets.join('-');
}

export function gweiToEth(gwei: number): number {
  return gwei / 1e9;
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

export function batchArray<T>(array: T[], batchSize: number): T[][] {
  const batchedArray: T[][] = [];

  for (let index = 0; index < array.length; index += batchSize) {
    const batch = array.slice(index, index + batchSize);
    batchedArray.push(batch);
  }

  return batchedArray;
}

export function parseNumberOrNull(input: any): number | null {
  if (input === null || input === undefined) {
    return null;
  }
  const parsed = parseInt(input);
  if (isNaN(parsed)) {
    return null;
  }
  return parsed;
}

export function parseIntOrNull(input: any): number | null {
  const num = parseNumberOrNull(input);
  const int = parseInt(input);
  if (num === int) {
    return int;
  }
  return null;
}

export function resolveEnum<T extends {}>(
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

export function isAirdrop(t: Transaction): boolean {
  return areEqualAddresses(t.from_address, NULL_ADDRESS) && t.value === 0;
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

export async function getWalletFromEns(
  identity: string
): Promise<string | null> {
  const normalisedIdentity = identity.toLowerCase();
  if (!normalisedIdentity.endsWith('.eth')) {
    return null;
  }
  const key = `ens2wallet-${normalisedIdentity}`;

  const cacheHit = mcache.get(key);
  if (cacheHit) {
    return cacheHit;
  } else {
    const alchemyResponse = await getAlchemyInstance()
      .core.resolveName(identity)
      .then((response) => response?.toLowerCase() ?? ``);
    mcache.put(key, alchemyResponse, Time.minutes(1).toMillis());
    return isWallet(alchemyResponse) ? alchemyResponse : null;
  }
}

export function isValidIP(ip: string): boolean {
  const ipv4FormatRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipv4FormatRegex.test(ip)) {
    return false;
  }

  const octets = ip.split('.').map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255);
}

export async function sleep(millis: number) {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

export function getUniqueValuesWithKeys<K, V>(map: Map<K, V>): Map<V, K[]> {
  const valueToKeysMap = new Map<V, K[]>();
  map.forEach((value, key) => {
    if (valueToKeysMap.has(value)) {
      valueToKeysMap.get(value)!.push(key);
    } else {
      valueToKeysMap.set(value, [key]);
    }
  });
  return valueToKeysMap;
}

export function isValidUuid(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    str
  );
}

export function isExperimentalModeOn() {
  return process.env.EXPERIMENTAL_MODE_ON === 'true';
}

export enum AppFeature {
  UPLOAD_CIC_REP_SNAPSHOTS_TO_ARWEAVE = 'UPLOAD_CIC_REP_SNAPSHOTS_TO_ARWEAVE'
}

export function isFeatureOn(feature: AppFeature) {
  return process.env[`FEATURE_${feature}`] === 'true';
}
