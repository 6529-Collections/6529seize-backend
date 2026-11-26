import { MEMES_CONTRACT } from '@/constants';

/*
 * A person's four subscription choices as signed records (kind 9 RECORD in
 * the `ps` family, one stream per owner: the principal, or the bare wallet
 * while it is bound to none). The newest record per (owner, type, key)
 * wins, so the key names what one choice is about:
 *
 *   subs.mode          key ''                    body {"automatic": bool}
 *   subs.all-editions  key ''                    body {"all": bool}
 *   subs.card          key '<contract>:<token>'  body {"subscribed": bool}
 *   subs.count         key '<contract>:<token>'  body {"count": int >= 1}
 *
 * The contract is The Memes in lowercase hex and the token a decimal
 * without leading zeros. A body has exactly these members; a record without
 * a body (an unset) is not a choice and is refused.
 */

export const SubscriptionRecordType = {
  MODE: 'subs.mode',
  ALL_EDITIONS: 'subs.all-editions',
  CARD: 'subs.card',
  COUNT: 'subs.count'
} as const;

export type SubscriptionRecordType =
  (typeof SubscriptionRecordType)[keyof typeof SubscriptionRecordType];

export type SubscriptionChange =
  | { readonly type: 'subs.mode'; readonly automatic: boolean }
  | { readonly type: 'subs.all-editions'; readonly all: boolean }
  | {
      readonly type: 'subs.card';
      readonly contract: string;
      readonly tokenId: number;
      readonly subscribed: boolean;
    }
  | {
      readonly type: 'subs.count';
      readonly contract: string;
      readonly tokenId: number;
      readonly count: number;
    };

/** What a record for a change carries: its type, key and body. */
export interface SubscriptionRecordContent {
  readonly type: SubscriptionRecordType;
  readonly key: string;
  readonly body: Record<string, unknown>;
}

export class SubscriptionRecordError extends Error {
  constructor(message: string) {
    super(message);
    // Keeps instanceof working when compiled to ES5.
    Object.setPrototypeOf(this, SubscriptionRecordError.prototype);
  }
}

const CARD_KEY = /^(0x[0-9a-f]{40}):([1-9]\d{0,15})$/;

function cardKey(contract: string, tokenId: number): string {
  return `${contract.toLowerCase()}:${tokenId}`;
}

export function recordContentOf(
  change: SubscriptionChange
): SubscriptionRecordContent {
  switch (change.type) {
    case 'subs.mode':
      return {
        type: change.type,
        key: '',
        body: { automatic: change.automatic }
      };
    case 'subs.all-editions':
      return { type: change.type, key: '', body: { all: change.all } };
    case 'subs.card':
      return {
        type: change.type,
        key: cardKey(change.contract, change.tokenId),
        body: { subscribed: change.subscribed }
      };
    case 'subs.count':
      return {
        type: change.type,
        key: cardKey(change.contract, change.tokenId),
        body: { count: change.count }
      };
  }
}

function onlyMember(
  type: string,
  body: Record<string, unknown> | null,
  member: string
): unknown {
  if (body === null) {
    throw new SubscriptionRecordError(
      `${type} has no body: an unset is not a choice`
    );
  }
  const members = Object.keys(body);
  if (members.length !== 1 || members[0] !== member) {
    throw new SubscriptionRecordError(`${type} carries exactly {"${member}"}`);
  }
  return body[member];
}

function boolean(type: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new SubscriptionRecordError(`${type} carries a true or false`);
  }
  return value;
}

function card(
  type: string,
  key: string
): { contract: string; tokenId: number } {
  const match = CARD_KEY.exec(key);
  if (match?.[1] !== MEMES_CONTRACT.toLowerCase()) {
    throw new SubscriptionRecordError(
      `${type} keys a card of The Memes as <contract>:<token>`
    );
  }
  const tokenId = Number(match[2]);
  if (!Number.isSafeInteger(tokenId)) {
    throw new SubscriptionRecordError(`${type} names a token out of range`);
  }
  return { contract: MEMES_CONTRACT, tokenId };
}

function count(type: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new SubscriptionRecordError(`${type} carries a count of 1 or more`);
  }
  return value;
}

/** The change a record states, or a SubscriptionRecordError. */
export function changeOfRecord(
  type: string,
  key: string,
  body: Record<string, unknown> | null
): SubscriptionChange {
  switch (type) {
    case SubscriptionRecordType.MODE:
    case SubscriptionRecordType.ALL_EDITIONS:
      if (key !== '') {
        throw new SubscriptionRecordError(`${type} has no key`);
      }
      return type === SubscriptionRecordType.MODE
        ? {
            type,
            automatic: boolean(type, onlyMember(type, body, 'automatic'))
          }
        : { type, all: boolean(type, onlyMember(type, body, 'all')) };
    case SubscriptionRecordType.CARD:
      return {
        type,
        ...card(type, key),
        subscribed: boolean(type, onlyMember(type, body, 'subscribed'))
      };
    case SubscriptionRecordType.COUNT:
      return {
        type,
        ...card(type, key),
        count: count(type, onlyMember(type, body, 'count'))
      };
    default:
      throw new SubscriptionRecordError(`${type} is not a subscription record`);
  }
}
