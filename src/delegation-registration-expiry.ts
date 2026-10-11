import { DELEGATIONS_IFACE } from '@/abis/delegations';
import { NEVER_DATE } from '@/constants';

// Delegation registrations are indexed from NFTDelegation logs. The events
// carry allTokens and the token id, but not the expiry date. The expiry is
// read from the contract's own state at the end of the event's block, so it
// is correct however the registration was submitted: directly, through a
// Safe or other contract wallet, through batchDelegations, or by a
// Delegation Manager. Decoding the top-level transaction input misses all
// but the first of these.

const STATE_VIEW = 'retrieveDelegationAddressesTokensIDsandExpiredDates';
const STATE_READ_CONCURRENCY = 5;

/** A registration log that needs its expiry date. */
export interface RegistrationLogRef {
  block: number;
  logIndex: number;
  delegator: string;
  collection: string;
  delegate: string;
  useCase: number;
  allTokens: boolean;
  tokenId: number;
}

/** A revocation log, used to spot registrations revoked in the same block. */
export interface RevocationLogRef {
  block: number;
  logIndex: number;
  delegator: string;
  collection: string;
  delegate: string;
  useCase: number;
}

export interface DelegationStateQuery {
  block: number;
  delegator: string;
  collection: string;
  useCase: number;
}

/** One stored registration, as the contract returns it. */
export interface DelegationStateEntry {
  delegate: string;
  expiry: bigint;
  allTokens: boolean;
  tokenId: bigint;
}

export type DelegationStateReader = (
  query: DelegationStateQuery
) => Promise<DelegationStateEntry[]>;

export type ContractCall = (
  to: string,
  data: string,
  blockTag: number
) => Promise<string>;

/**
 * Reads every registration a delegator holds for one collection and use case,
 * as stored at the end of `query.block`. Entries for one delegate are
 * returned in registration order. Throws when the call or decoding fails.
 */
export function createDelegationStateReader(
  call: ContractCall,
  contractAddress: string
): DelegationStateReader {
  return async (query) => {
    const data = DELEGATIONS_IFACE.encodeFunctionData(STATE_VIEW, [
      query.delegator,
      query.collection,
      query.useCase
    ]);
    const raw = await call(contractAddress, data, query.block);
    const [delegates, expiries, allTokens, tokenIds] =
      DELEGATIONS_IFACE.decodeFunctionResult(STATE_VIEW, raw);
    if (
      delegates.length !== expiries.length ||
      delegates.length !== allTokens.length ||
      delegates.length !== tokenIds.length
    ) {
      throw new Error(
        `Inconsistent delegation state for ${describeQuery(query)}`
      );
    }
    return Array.from(delegates as string[], (delegate, index) => ({
      delegate,
      expiry: BigInt(expiries[index]),
      allTokens: Boolean(allTokens[index]),
      tokenId: BigInt(tokenIds[index])
    }));
  };
}

/**
 * Resolves the expiry of each registration, returned in input order.
 *
 * `null` marks a registration that a later log in the same block revoked:
 * the contract no longer holds it at the end of that block, and it is not
 * active, so it must not be stored.
 *
 * Throws when a state read fails or the stored registrations do not match
 * the logs, so the caller retries instead of storing guessed values.
 */
export async function resolveRegistrationExpiries(
  registrations: RegistrationLogRef[],
  revocations: RevocationLogRef[],
  readState: DelegationStateReader
): Promise<(number | null)[]> {
  const expiries: (number | null)[] = registrations.map(() => null);
  const lastRevocation = new Map<string, number>();
  for (const revocation of revocations) {
    const key = registrationKey(revocation);
    lastRevocation.set(
      key,
      Math.max(lastRevocation.get(key) ?? -1, revocation.logIndex)
    );
  }

  const groups = new Map<string, StateReadGroup>();
  registrations.forEach((registration, index) => {
    const revokedAt = lastRevocation.get(registrationKey(registration));
    if (revokedAt !== undefined && revokedAt > registration.logIndex) {
      return;
    }
    const key = stateQueryKey(registration);
    let group = groups.get(key);
    if (!group) {
      group = {
        query: {
          block: registration.block,
          delegator: registration.delegator,
          collection: registration.collection,
          useCase: registration.useCase
        },
        members: []
      };
      groups.set(key, group);
    }
    group.members.push({ registration, index });
  });

  const pending = Array.from(groups.values());
  for (let i = 0; i < pending.length; i += STATE_READ_CONCURRENCY) {
    const chunk = pending.slice(i, i + STATE_READ_CONCURRENCY);
    const states = await Promise.all(
      chunk.map((group) => readState(group.query))
    );
    chunk.forEach((group, chunkIndex) => {
      assignExpiries(group, states[chunkIndex], expiries);
    });
  }
  return expiries;
}

interface StateReadGroup {
  query: DelegationStateQuery;
  members: { registration: RegistrationLogRef; index: number }[];
}

// Registrations for one delegate in one block are the last entries the
// contract holds for that delegate at the end of the block, in log order:
// each registration appends one entry, and a revocation deletes them all.
function assignExpiries(
  group: StateReadGroup,
  state: DelegationStateEntry[],
  expiries: (number | null)[]
) {
  const byDelegate = new Map<string, StateReadGroup['members']>();
  for (const member of group.members) {
    const delegate = member.registration.delegate.toLowerCase();
    const members = byDelegate.get(delegate) ?? [];
    members.push(member);
    byDelegate.set(delegate, members);
  }

  for (const [delegate, members] of Array.from(byDelegate.entries())) {
    members.sort((a, b) => a.registration.logIndex - b.registration.logIndex);
    const entries = state.filter((e) => e.delegate.toLowerCase() === delegate);
    if (entries.length < members.length) {
      throw new Error(
        `Expected ${members.length} stored registration(s) for delegate ${delegate} but found ${entries.length} for ${describeQuery(group.query)}`
      );
    }
    const latest = entries.slice(entries.length - members.length);
    members.forEach(({ registration, index }, position) => {
      const entry = latest[position];
      if (!matchesScope(registration, entry)) {
        throw new Error(
          `Stored registration does not match log ${registration.block}:${registration.logIndex} for delegate ${delegate} on ${describeQuery(group.query)}`
        );
      }
      expiries[index] = toExpirySeconds(entry.expiry);
    });
  }
}

// The contract stores token 0 for all-token registrations, whatever token id
// the caller passed.
function matchesScope(
  registration: RegistrationLogRef,
  entry: DelegationStateEntry
): boolean {
  if (registration.allTokens !== entry.allTokens) {
    return false;
  }
  return (
    registration.allTokens || entry.tokenId === BigInt(registration.tokenId)
  );
}

// Expiry dates beyond the safe integer range cannot be stored exactly; they
// are far past any meaningful date, so they are treated as never expiring.
function toExpirySeconds(expiry: bigint): number {
  return expiry > BigInt(Number.MAX_SAFE_INTEGER) ? NEVER_DATE : Number(expiry);
}

function registrationKey(ref: RegistrationLogRef | RevocationLogRef): string {
  return [
    ref.block,
    ref.delegator.toLowerCase(),
    ref.collection.toLowerCase(),
    ref.delegate.toLowerCase(),
    ref.useCase
  ].join('|');
}

function stateQueryKey(ref: RegistrationLogRef): string {
  return [
    ref.block,
    ref.delegator.toLowerCase(),
    ref.collection.toLowerCase(),
    ref.useCase
  ].join('|');
}

function describeQuery(query: DelegationStateQuery): string {
  return `delegator ${query.delegator} collection ${query.collection} use case ${query.useCase} at block ${query.block}`;
}
