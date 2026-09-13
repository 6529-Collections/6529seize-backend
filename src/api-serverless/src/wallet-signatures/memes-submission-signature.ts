import { createHash } from 'node:crypto';
import { ethers } from 'ethers';
import * as Joi from 'joi';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { normalizeWebAppOrigin } from '@/api/web-app-origins';
import {
  canonicalJSONStringify,
  consumeStructuredWalletSignatureNonce,
  verifyContractWalletSignatureHash
} from '@/api/wallet-signatures/structured-wallet-signatures';

export const MEMES_SUBMISSION_ACTION = 'Submit a Meme Card to The Memes';
export const MEMES_SUBMISSION_AGREEMENT =
  'I agree to The Memes submission terms I reviewed.';
export const MEMES_SUBMISSION_NOTICE =
  'Submission only. No mint, token approval or asset transfer. No gas fee.';
export const MEMES_SUBMISSION_DOMAIN = {
  name: 'The Memes',
  version: '1',
  chainId: 1
} as const;
export const MEMES_SUBMISSION_PRIMARY_TYPE = 'MemeCardSubmission';
export const MEMES_SUBMISSION_TYPES: Record<string, ethers.TypedDataField[]> = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' }
  ],
  MemeCardSubmission: [
    { name: 'Action', type: 'string' },
    { name: 'Artwork', type: 'string' },
    { name: 'Destination', type: 'string' },
    { name: 'Agreement', type: 'string' },
    { name: 'Notice', type: 'string' },
    { name: 'ExpiresAt', type: 'string' },
    { name: 'Verification', type: 'SubmissionVerification' }
  ],
  SubmissionVerification: [
    { name: 'Wallet', type: 'address' },
    { name: 'WaveId', type: 'string' },
    { name: 'Audience', type: 'string' },
    { name: 'Origin', type: 'string' },
    { name: 'IssuedAt', type: 'string' },
    { name: 'Nonce', type: 'string' },
    { name: 'PayloadHash', type: 'bytes32' },
    { name: 'TermsHash', type: 'bytes32' }
  ]
};

const SIGNING_TYPES = {
  MemeCardSubmission: MEMES_SUBMISSION_TYPES.MemeCardSubmission,
  SubmissionVerification: MEMES_SUBMISSION_TYPES.SubmissionVerification
};
const MAX_ENVELOPE_BYTES = 32_768;
const MAX_LIFETIME_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const NONCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface MemesSubmissionMessage {
  Action: string;
  Artwork: string;
  Destination: string;
  Agreement: string;
  Notice: string;
  ExpiresAt: string;
  Verification: {
    Wallet: string;
    WaveId: string;
    Audience: string;
    Origin: string;
    IssuedAt: string;
    Nonce: string;
    PayloadHash: string;
    TermsHash: string;
  };
}

export interface MemesSubmissionEnvelope {
  domain: typeof MEMES_SUBMISSION_DOMAIN;
  types: typeof MEMES_SUBMISSION_TYPES;
  primaryType: typeof MEMES_SUBMISSION_PRIMARY_TYPE;
  message: MemesSubmissionMessage;
}

interface VerifyMemesSubmissionParams {
  message: string;
  signature: string;
  drop: ApiCreateDropRequest;
  wallets: string[];
  payloadHash: string;
  termsOfService: string | null;
  expectedWaveId: string | null;
  expectedWaveName: string | null;
  expectedAudience: string | null;
}

const messageSchema = Joi.object<MemesSubmissionMessage>({
  Action: Joi.string().valid(MEMES_SUBMISSION_ACTION).required(),
  Artwork: Joi.string().min(1).max(250).required(),
  Destination: Joi.string().min(1).max(250).required(),
  Agreement: Joi.string().valid(MEMES_SUBMISSION_AGREEMENT).required(),
  Notice: Joi.string().valid(MEMES_SUBMISSION_NOTICE).required(),
  ExpiresAt: Joi.string().max(30).required(),
  Verification: Joi.object({
    Wallet: Joi.string().max(42).required(),
    WaveId: Joi.string().max(100).required(),
    Audience: Joi.string().max(255).required(),
    Origin: Joi.string().max(2048).required(),
    IssuedAt: Joi.string().max(30).required(),
    Nonce: Joi.string().pattern(NONCE_PATTERN).required(),
    PayloadHash: Joi.string().pattern(HASH_PATTERN).required(),
    TermsHash: Joi.string().pattern(HASH_PATTERN).required()
  })
    .unknown(false)
    .required()
}).unknown(false);

const envelopeSchema = Joi.object<MemesSubmissionEnvelope>({
  domain: Joi.object().required(),
  types: Joi.object().required(),
  primaryType: Joi.string().valid(MEMES_SUBMISSION_PRIMARY_TYPE).required(),
  message: messageSchema.required()
}).unknown(false);

export function parseMemesSubmissionEnvelope(
  value: string
): MemesSubmissionEnvelope | null {
  if (Buffer.byteLength(value, 'utf8') > MAX_ENVELOPE_BYTES) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    const result = envelopeSchema.validate(parsed, { convert: false });
    if (result.error) {
      return null;
    }
    const envelope = result.value;
    if (
      canonicalJSONStringify(envelope.domain) !==
        canonicalJSONStringify(MEMES_SUBMISSION_DOMAIN) ||
      canonicalJSONStringify(envelope.types) !==
        canonicalJSONStringify(MEMES_SUBMISSION_TYPES)
    ) {
      return null;
    }
    return envelope;
  } catch {
    return null;
  }
}

export async function verifyMemesSubmissionSignature(
  params: VerifyMemesSubmissionParams
): Promise<boolean> {
  const envelope = parseMemesSubmissionEnvelope(params.message);
  if (!envelope || !matchesSubmission(envelope.message, params)) {
    return false;
  }
  const message = envelope.message;
  const verification = message.Verification;
  const wallet = verification.Wallet.toLowerCase();
  if (!hasValidSigner(verification.Wallet, params.drop, params.wallets)) {
    return false;
  }
  const issuedAt = parseCanonicalDate(verification.IssuedAt);
  const expirationTime = parseCanonicalDate(message.ExpiresAt);
  if (
    !issuedAt ||
    !expirationTime ||
    !isTimingValid(issuedAt, expirationTime)
  ) {
    return false;
  }
  if (!(await matchesSignature(message, params.signature, wallet))) {
    return false;
  }
  return consumeStructuredWalletSignatureNonce({
    kind: 'action',
    action: 'create_drop',
    wallet,
    nonce: verification.Nonce,
    audience: verification.Audience,
    domain: new URL(verification.Origin).host,
    clientOrigin: verification.Origin,
    chainId: MEMES_SUBMISSION_DOMAIN.chainId,
    issuedAt,
    expirationTime,
    purpose: MEMES_SUBMISSION_ACTION,
    payloadHash: params.payloadHash
  });
}

function matchesSubmission(
  message: MemesSubmissionMessage,
  params: VerifyMemesSubmissionParams
): boolean {
  const { drop, termsOfService, expectedWaveId, expectedAudience } = params;
  if (!expectedWaveId || !expectedAudience || !termsOfService?.trim()) {
    return false;
  }
  const verification = message.Verification;
  return (
    drop.drop_type === ApiDropType.Participatory &&
    drop.wave_id === expectedWaveId &&
    verification.WaveId === expectedWaveId &&
    message.Artwork === drop.title &&
    message.Artwork === message.Artwork.trim() &&
    message.Destination === params.expectedWaveName &&
    verification.Audience === expectedAudience &&
    // Origin records client context; native WebViews and external clients are
    // supported. The exact API audience above binds the destination environment.
    normalizeWebAppOrigin(verification.Origin) === verification.Origin &&
    verification.PayloadHash === `0x${params.payloadHash}` &&
    verification.TermsHash ===
      `0x${createHash('sha256').update(termsOfService, 'utf8').digest('hex')}`
  );
}

function hasValidSigner(
  wallet: string,
  drop: ApiCreateDropRequest,
  candidates: string[]
): boolean {
  const normalizedWallet = wallet.toLowerCase();
  return (
    ethers.isAddress(wallet) &&
    drop.signer_address?.toLowerCase() === normalizedWallet &&
    candidates.some((candidate) => candidate.toLowerCase() === normalizedWallet)
  );
}

function parseCanonicalDate(value: string): Date | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  const parsed = new Date(timestamp);
  return parsed.toISOString() === value ? parsed : null;
}

function isTimingValid(issuedAt: Date, expiresAt: Date): boolean {
  const issuedAtMs = issuedAt.getTime();
  const expiresAtMs = expiresAt.getTime();
  const now = Date.now();
  return (
    expiresAtMs > now &&
    issuedAtMs <= now + MAX_FUTURE_SKEW_MS &&
    expiresAtMs > issuedAtMs &&
    expiresAtMs - issuedAtMs <= MAX_LIFETIME_MS
  );
}

async function matchesSignature(
  message: MemesSubmissionMessage,
  signature: string,
  wallet: string
): Promise<boolean> {
  try {
    const recovered = ethers.verifyTypedData(
      MEMES_SUBMISSION_DOMAIN,
      SIGNING_TYPES,
      message,
      signature
    );
    if (recovered.toLowerCase() === wallet) {
      return true;
    }
  } catch {
    // Contract-wallet signatures need not have the length or encoding of ECDSA.
  }
  return verifyContractWalletSignatureHash({
    address: wallet,
    chainId: MEMES_SUBMISSION_DOMAIN.chainId,
    messageHash: ethers.TypedDataEncoder.hash(
      MEMES_SUBMISSION_DOMAIN,
      SIGNING_TYPES,
      message
    ),
    signature
  });
}
