import { TypedDataEncoder } from 'ethers';
import { ChainDraft } from '@/chain-gateway/chain-gateway.types';

/**
 * What a SETTLEMENT_REQUEST draft from the gateway must be before the sender
 * key signs its txId. The EIP-712 types and the domain are fixed here as the
 * chain defines them (chain-tx's schema: TxHeader, SettlementRequestBody and
 * their root), never taken from the gateway. Every header field is checked,
 * the message is rebuilt from the checked header and the body the sender
 * asked for, and the txId must be that message's digest. So the key signs a
 * settlement request from its own address account and nothing else.
 */

/** SETTLEMENT_REQUEST's operation code. */
export const SETTLEMENT_REQUEST_OP = 0x0609;
/** The first rule version that runs SETTLEMENT_REQUEST. */
const FIRST_RULE_VERSION = 7;
/** A header's fee mode when its signer pays. */
const FEE_MODE_SIGNER = 3;
/** The signature role of a transaction's signer. */
const ROLE_SIGNER = 0;
/** The most work any rule set may let one transaction use. */
const MAX_TX_WORK_BOUND = BigInt(20_000_000);
/** How far the chain's clock and ours may disagree. */
export const CLOCK_SLACK_MS = 2 * 60_000;
/** The default cap on a request's maxFee: 100 coins of 18 decimals. */
export const DEFAULT_MAX_FEE = BigInt('100000000000000000000');

const ZERO32 = '0x' + '00'.repeat(32);
const HEX32 = /^0x[0-9a-f]{64}$/;

const TX_HEADER = [
  { name: 'ruleVersion', type: 'uint32' },
  { name: 'principal', type: 'bytes32' },
  { name: 'keyType', type: 'uint8' },
  { name: 'keyId', type: 'bytes32' },
  { name: 'authRef', type: 'bytes32' },
  { name: 'nonceLane', type: 'uint32' },
  { name: 'nonce', type: 'uint64' },
  { name: 'notBefore', type: 'uint64' },
  { name: 'expiresAt', type: 'uint64' },
  { name: 'ethRefNumber', type: 'uint64' },
  { name: 'ethRefHash', type: 'bytes32' },
  { name: 'feeMode', type: 'uint8' },
  { name: 'sponsorRef', type: 'bytes32' },
  { name: 'maxFee', type: 'uint128' },
  { name: 'maxWork', type: 'uint64' },
  { name: 'tipPerRU', type: 'uint128' }
];

/** SETTLEMENT_REQUEST's EIP-712 types, as chain-tx's schema has them. */
export const SETTLEMENT_TYPES = {
  SettlementRequest: [
    { name: 'header', type: 'TxHeader' },
    { name: 'body', type: 'SettlementRequestBody' }
  ],
  SettlementRequestBody: [
    { name: 'decisionId', type: 'bytes32' },
    { name: 'occurrence', type: 'uint32' },
    { name: 'maxEntries', type: 'uint16' }
  ],
  TxHeader: TX_HEADER
};

/** The chain's EIP-712 domain: its salt is the network id. */
export function settlementDomain(networkId: string) {
  return { name: '6529 Network', version: '1', salt: networkId };
}

export interface SettlementSettings {
  /** The network id to sign for; null: the one the due read names. */
  readonly networkId: string | null;
  /** The most a request may offer to pay (maxFee, base units). */
  readonly maxFee: bigint;
}

export type SettlementSettingsResult =
  | { readonly ok: true; readonly settings: SettlementSettings }
  | { readonly ok: false; readonly problem: string };

/**
 * - WAVES_SETTLEMENT_NETWORK_ID (`0x` and 64 hex digits): the chain the
 *   sender signs for. Set it in production: without it the domain's salt
 *   is the network the gateway's own read names.
 * - WAVES_SETTLEMENT_MAX_FEE (a whole number of base units, default 100
 *   coins): the maxFee each request carries. A request pays only what it
 *   uses, and the payer holds only the worst case at the base fees, so a
 *   high cap costs nothing; a draft whose worst case is above it is not
 *   sent.
 */
export function settlementSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SettlementSettingsResult {
  const networkId = env.WAVES_SETTLEMENT_NETWORK_ID?.trim().toLowerCase();
  if (networkId && !HEX32.test(networkId)) {
    return { ok: false, problem: 'WAVES_SETTLEMENT_NETWORK_ID is malformed' };
  }
  const maxFee = env.WAVES_SETTLEMENT_MAX_FEE?.trim();
  if (maxFee && !/^\d{1,39}$/.test(maxFee)) {
    return { ok: false, problem: 'WAVES_SETTLEMENT_MAX_FEE is malformed' };
  }
  return {
    ok: true,
    settings: {
      networkId: networkId || null,
      maxFee: maxFee ? BigInt(maxFee) : DEFAULT_MAX_FEE
    }
  };
}

/** What the sender asked for and what it accepts. */
export interface SettlementDraftWant {
  readonly decisionId: string;
  readonly occurrence: number;
  readonly maxEntries: number;
  /** The sender wallet's address, lowercase. */
  readonly signer: string;
  readonly lane: number;
  readonly networkId: string;
  readonly maxFee: bigint;
  readonly validForMs: number;
  readonly now: number;
}

function uint(value: unknown, bits: number): bigint | null {
  let n: bigint;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    n = BigInt(value);
  } else if (typeof value === 'string' && /^\d{1,40}$/.test(value)) {
    n = BigInt(value);
  } else {
    return null;
  }
  return n < BigInt(1) << BigInt(bits) ? n : null;
}

function word(value: unknown): string | null {
  return typeof value === 'string' && HEX32.test(value.toLowerCase())
    ? value.toLowerCase()
    : null;
}

/**
 * The draft's worst-case fee at the next slot's base fees (`fee.worst`), or
 * null when it can't be read. A request whose maxFee is below it is refused
 * (0x0305 FEE_UNCOVERED).
 */
export function worstFeeOf(draft: ChainDraft): bigint | null {
  return uint(draft.fee?.worst, 128);
}

/**
 * The txId to sign, the signature entry to send and the request's maxFee,
 * or an Error naming what in the draft was refused.
 */
export function checkSettlementDraft(
  draft: ChainDraft,
  want: SettlementDraftWant
): { txId: string; role: number; keyType: number; maxFee: bigint } {
  const refuse = (what: string): never => {
    throw new Error(`the draft was refused: ${what}`);
  };
  if (draft.opType !== SETTLEMENT_REQUEST_OP || draft.opVersion !== 1) {
    refuse('not a SETTLEMENT_REQUEST version 1');
  }
  const message = (draft.typedData as { message?: { header?: unknown } })
    ?.message;
  const raw = (message?.header ?? {}) as Record<string, unknown>;
  const header = {
    ruleVersion: uint(raw.ruleVersion, 32),
    principal: word(raw.principal),
    keyType: uint(raw.keyType, 8),
    keyId: word(raw.keyId),
    authRef: word(raw.authRef),
    nonceLane: uint(raw.nonceLane, 32),
    nonce: uint(raw.nonce, 64),
    notBefore: uint(raw.notBefore, 64),
    expiresAt: uint(raw.expiresAt, 64),
    ethRefNumber: uint(raw.ethRefNumber, 64),
    ethRefHash: word(raw.ethRefHash),
    feeMode: uint(raw.feeMode, 8),
    sponsorRef: word(raw.sponsorRef),
    maxFee: uint(raw.maxFee, 128),
    maxWork: uint(raw.maxWork, 64),
    tipPerRU: uint(raw.tipPerRU, 128)
  };
  for (const [name, value] of Object.entries(header)) {
    if (value === null) refuse(`header ${name} can't be read`);
  }
  const h = header as {
    [K in keyof typeof header]: NonNullable<(typeof header)[K]>;
  };
  const big = (n: number) => BigInt(n);
  const keyId = '0x' + '00'.repeat(12) + want.signer.slice(2);
  const checks: [boolean, string][] = [
    [h.ruleVersion >= big(FIRST_RULE_VERSION), 'ruleVersion'],
    [h.principal === ZERO32, 'principal (the address account pays)'],
    [h.keyType === big(1), 'keyType'],
    [h.keyId === keyId, 'keyId (another signer)'],
    [h.authRef === ZERO32, 'authRef'],
    [h.nonceLane === big(want.lane), 'nonceLane'],
    [h.nonce < (BigInt(1) << BigInt(64)) - BigInt(1), 'nonce'],
    [
      h.notBefore <= big(want.now + CLOCK_SLACK_MS),
      'notBefore (later than now)'
    ],
    [h.expiresAt > big(want.now), 'expiresAt (already past)'],
    [
      h.expiresAt <= big(want.now + want.validForMs + CLOCK_SLACK_MS),
      'expiresAt (valid for too long)'
    ],
    [h.notBefore < h.expiresAt, 'notBefore (not before expiresAt)'],
    [h.ethRefNumber === big(0) && h.ethRefHash === ZERO32, 'ethRef'],
    [h.feeMode === big(FEE_MODE_SIGNER), 'feeMode'],
    [h.sponsorRef === ZERO32, 'sponsorRef'],
    [h.maxFee <= want.maxFee, `maxFee (over the cap ${want.maxFee})`],
    [h.maxWork > big(0) && h.maxWork <= MAX_TX_WORK_BOUND, 'maxWork'],
    [h.tipPerRU === big(0), 'tipPerRU (a tip)']
  ];
  for (const [ok, what] of checks) {
    if (!ok) refuse(`header ${what}`);
  }
  const txId = TypedDataEncoder.hash(
    settlementDomain(want.networkId),
    SETTLEMENT_TYPES,
    {
      header: h,
      body: {
        decisionId: want.decisionId,
        occurrence: want.occurrence,
        maxEntries: want.maxEntries
      }
    }
  ).toLowerCase();
  if (txId !== String(draft.txId).toLowerCase()) {
    refuse("its txId is not this settlement request's digest");
  }
  const entries = draft.signatures ?? [];
  if (
    entries.length !== 1 ||
    String(entries[0].signer).toLowerCase() !== want.signer ||
    entries[0].keyType !== 1 ||
    entries[0].role !== ROLE_SIGNER
  ) {
    refuse('it asks for another signature');
  }
  return { txId, role: ROLE_SIGNER, keyType: 1, maxFee: h.maxFee };
}
