import { createHash } from 'crypto';
import { ethers } from 'ethers';
import { env } from '@/env';
import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';
import { isCorsOriginAllowed } from '@/api/api-constants';

const logger = Logger.get('STRUCTURED_WALLET_SIGNATURES');

export const STRUCTURED_WALLET_SIGNATURE_VERSION = 2;
export const STRUCTURED_WALLET_SIGNATURE_TTL_SECONDS = 5 * 60;
const MAX_ISSUED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_SIGNATURE_TTL_MS = 10 * 60 * 1000;
const EIP1271_MAGIC_VALUE = '0x1626ba7e';
const EIP1271_ABI = [
  'function isValidSignature(bytes32 _messageHash, bytes _signature) public view returns (bytes4)'
];

const localConsumedNonceExpirations = new Map<string, number>();

export type StructuredWalletSignatureKind = 'authentication' | 'action';

export type StructuredWalletSignatureAction =
  | 'login'
  | 'create_drop'
  | 'add_rememe'
  | 'nextgen_admin';

export interface ParsedStructuredWalletSignatureMessage {
  kind: StructuredWalletSignatureKind;
  domain: string;
  wallet: string;
  chainId: number;
  issuedAt: Date;
  expirationTime: Date;
  nonce: string;
  action: StructuredWalletSignatureAction;
  payloadHash?: string;
  purpose: string;
}

interface StructuredWalletSignatureMessageInput {
  kind: StructuredWalletSignatureKind;
  domain: string;
  wallet: string;
  chainId?: number;
  issuedAt?: Date;
  expirationTime?: Date;
  nonce: string;
  action: StructuredWalletSignatureAction;
  payloadHash?: string | null;
  purpose: string;
}

interface VerifyStructuredWalletSignatureParams {
  message: string;
  signature: string;
  expectedAddress: string;
  expectedAction: StructuredWalletSignatureAction;
  expectedPayloadHash?: string | null;
  expectedKind?: StructuredWalletSignatureKind;
  isContractWalletHint?: boolean;
  consumeNonce?: boolean;
}

export function isStructuredSignaturesRequired(): boolean {
  return process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED === 'true';
}

export function isStructuredWalletSignatureMessage(message: string): boolean {
  return (
    message.startsWith('6529 Authentication\n') ||
    message.startsWith('6529 Action\n')
  );
}

export function buildStructuredWalletSignatureMessage({
  kind,
  domain,
  wallet,
  chainId = 1,
  issuedAt = new Date(),
  expirationTime = new Date(
    issuedAt.getTime() + STRUCTURED_WALLET_SIGNATURE_TTL_SECONDS * 1000
  ),
  nonce,
  action,
  payloadHash,
  purpose
}: StructuredWalletSignatureMessageInput): string {
  const lines = [
    kind === 'authentication' ? '6529 Authentication' : '6529 Action',
    `Version: ${STRUCTURED_WALLET_SIGNATURE_VERSION}`,
    `Domain: ${domain}`,
    `Wallet: ${wallet}`,
    `Chain ID: ${chainId}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expirationTime.toISOString()}`,
    `Nonce: ${nonce}`,
    `Action: ${action}`
  ];

  if (payloadHash) {
    lines.push(`Payload Hash: ${payloadHash}`);
  }

  lines.push(`Purpose: ${purpose}`);
  return lines.join('\n');
}

export function canonicalJSONStringify(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((it) => canonicalJSONStringify(it)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keyValuePairs = Object.keys(record)
    .sort((a, b) => a.localeCompare(b))
    .filter((key) => record[key] !== undefined)
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJSONStringify(record[key])}`
    );
  return `{${keyValuePairs.join(',')}}`;
}

export function hashStructuredWalletSignaturePayload(payload: unknown): string {
  return createHash('sha256')
    .update(canonicalJSONStringify(payload))
    .digest('hex');
}

export function parseStructuredWalletSignatureMessage(
  message: string
): ParsedStructuredWalletSignatureMessage | null {
  const lines = message.split(/\r?\n/);
  const kind = parseKind(lines[0]);
  if (!kind) {
    return null;
  }

  const fields = parseFields(lines.slice(1));
  if (!fields) {
    return null;
  }

  const version = fields.get('Version');
  const domain = normalizeDomain(fields.get('Domain'));
  const wallet = fields.get('Wallet');
  const chainId = Number(fields.get('Chain ID'));
  const issuedAt = parseDateField(fields.get('Issued At'));
  const expirationTime = parseDateField(fields.get('Expiration Time'));
  const nonce = fields.get('Nonce');
  const action = parseAction(fields.get('Action'));
  const payloadHash = fields.get('Payload Hash')?.toLowerCase();
  const purpose = fields.get('Purpose');

  if (
    version !== String(STRUCTURED_WALLET_SIGNATURE_VERSION) ||
    !domain ||
    !wallet ||
    !ethers.isAddress(wallet) ||
    !Number.isInteger(chainId) ||
    chainId < 1 ||
    !issuedAt ||
    !expirationTime ||
    !nonce ||
    !isValidNonce(nonce) ||
    !action ||
    !purpose ||
    purpose.trim().length === 0
  ) {
    return null;
  }

  if (payloadHash && !/^[a-f0-9]{64}$/.test(payloadHash)) {
    return null;
  }

  return {
    kind,
    domain,
    wallet: wallet.toLowerCase(),
    chainId,
    issuedAt,
    expirationTime,
    nonce,
    action,
    ...(payloadHash ? { payloadHash } : {}),
    purpose
  };
}

export async function verifyStructuredWalletSignature({
  message,
  signature,
  expectedAddress,
  expectedAction,
  expectedPayloadHash,
  expectedKind,
  isContractWalletHint = false,
  consumeNonce = true
}: VerifyStructuredWalletSignatureParams): Promise<string | null> {
  const parsed = parseStructuredWalletSignatureMessage(message);
  const expectedAddressLowerCase = expectedAddress.toLowerCase();
  if (!parsed || !ethers.isAddress(expectedAddress)) {
    return null;
  }

  if (
    parsed.wallet !== expectedAddressLowerCase ||
    parsed.action !== expectedAction ||
    (expectedKind && parsed.kind !== expectedKind) ||
    !isSignatureTimingValid(parsed) ||
    !isStructuredSignatureDomainAllowed(parsed.domain)
  ) {
    return null;
  }

  if (
    expectedPayloadHash !== undefined &&
    expectedPayloadHash !== null &&
    parsed.payloadHash !== expectedPayloadHash.toLowerCase()
  ) {
    return null;
  }

  const recoveredAddress = recoverPersonalSignAddress(message, signature);
  const signatureMatches =
    recoveredAddress === expectedAddressLowerCase ||
    (isContractWalletHint &&
      (await verifyContractWalletSignature({
        address: expectedAddressLowerCase,
        message,
        signature
      })));

  if (!signatureMatches) {
    return null;
  }

  if (consumeNonce) {
    const nonceWasConsumed = await consumeStructuredSignatureNonce(parsed);
    if (!nonceWasConsumed) {
      return null;
    }
  }

  return expectedAddressLowerCase;
}

export function clearStructuredWalletSignatureReplayCacheForTests(): void {
  localConsumedNonceExpirations.clear();
}

function parseKind(
  value: string | undefined
): StructuredWalletSignatureKind | null {
  if (value === '6529 Authentication') {
    return 'authentication';
  }
  if (value === '6529 Action') {
    return 'action';
  }
  return null;
}

function parseFields(lines: string[]): Map<string, string> | null {
  const fields = new Map<string, string>();
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const delimiterIndex = line.indexOf(':');
    if (delimiterIndex <= 0) {
      return null;
    }
    const key = line.slice(0, delimiterIndex).trim();
    const value = line.slice(delimiterIndex + 1).trim();
    if (fields.has(key)) {
      return null;
    }
    fields.set(key, value);
  }
  return fields;
}

function parseAction(
  value: string | undefined
): StructuredWalletSignatureAction | null {
  if (
    value === 'login' ||
    value === 'create_drop' ||
    value === 'add_rememe' ||
    value === 'nextgen_admin'
  ) {
    return value;
  }
  return null;
}

function parseDateField(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function normalizeDomain(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(
      trimmed.includes('://') ? trimmed : `https://${trimmed}`
    );
    return parsed.host;
  } catch {
    return null;
  }
}

function isValidNonce(value: string): boolean {
  return (
    value.length >= 8 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function isSignatureTimingValid(
  parsed: ParsedStructuredWalletSignatureMessage
): boolean {
  const now = Date.now();
  const issuedAtMs = parsed.issuedAt.getTime();
  const expiresAtMs = parsed.expirationTime.getTime();
  return (
    expiresAtMs > now &&
    issuedAtMs <= now + MAX_ISSUED_AT_FUTURE_SKEW_MS &&
    expiresAtMs > issuedAtMs &&
    expiresAtMs - issuedAtMs <= MAX_SIGNATURE_TTL_MS
  );
}

function isStructuredSignatureDomainAllowed(domain: string): boolean {
  const configuredDomains =
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS?.split(',')
      .map((it) => normalizeDomain(it))
      .filter((it): it is string => !!it) ?? [];

  if (configuredDomains.includes(domain)) {
    return true;
  }

  return (
    isCorsOriginAllowed(`https://${domain}`) ||
    isCorsOriginAllowed(`http://${domain}`)
  );
}

function recoverPersonalSignAddress(
  message: string,
  signature: string
): string | null {
  try {
    return ethers.verifyMessage(message, signature)?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

async function verifyContractWalletSignature({
  address,
  message,
  signature
}: {
  address: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  try {
    const provider = new ethers.JsonRpcProvider(
      `https://eth-mainnet.alchemyapi.io/v2/${env.getStringOrThrow(`ALCHEMY_API_KEY`)}`
    );
    const contract = new ethers.Contract(address, EIP1271_ABI, provider);
    const result = await contract.isValidSignature(
      ethers.hashMessage(message),
      signature
    );
    return String(result).toLowerCase() === EIP1271_MAGIC_VALUE;
  } catch (error) {
    logger.warn(
      'Structured contract-wallet signature verification failed',
      error
    );
    return false;
  }
}

async function consumeStructuredSignatureNonce(
  parsed: ParsedStructuredWalletSignatureMessage
): Promise<boolean> {
  const key = buildReplayKey(parsed);
  const expiresAtMs = parsed.expirationTime.getTime();
  const ttlSeconds = Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000));
  const redis = getRedisClient();
  if (!redis) {
    return consumeLocalNonce(key, expiresAtMs);
  }

  try {
    const result = await redis.set(key, '1', {
      NX: true,
      EX: ttlSeconds
    });
    return result === 'OK';
  } catch (error) {
    logger.error('Structured signature nonce replay check failed', error);
    return consumeLocalNonce(key, expiresAtMs);
  }
}

function buildReplayKey(
  parsed: ParsedStructuredWalletSignatureMessage
): string {
  const nonceHash = createHash('sha256').update(parsed.nonce).digest('hex');
  return [
    'wallet_signature_nonce_v2',
    parsed.action,
    parsed.wallet,
    nonceHash
  ].join(':');
}

function consumeLocalNonce(key: string, expiresAtMs: number): boolean {
  const now = Date.now();
  localConsumedNonceExpirations.forEach((expirationMs, cachedKey) => {
    if (expirationMs <= now) {
      localConsumedNonceExpirations.delete(cachedKey);
    }
  });

  if ((localConsumedNonceExpirations.get(key) ?? 0) > now) {
    return false;
  }

  localConsumedNonceExpirations.set(key, expiresAtMs);
  return true;
}
