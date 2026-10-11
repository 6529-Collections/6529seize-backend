import { DELEGATIONS_IFACE } from '@/abis/delegations';
import { NEVER_DATE } from '@/constants';
import { solidityPackedKeccak256 } from 'ethers';

// Delegation registrations are indexed from NFTDelegation logs. The events
// carry allTokens and the token id, but not the expiry date. The expiry is
// read from the contract's own state at the end of the event's block, so it
// is correct however the registration was submitted: directly, through a
// Safe or other contract wallet, through batchDelegations, or by a
// Delegation Manager. Decoding the top-level transaction input misses all
// but the first of these.
//
// Contract storage, for one delegator, collection and use case:
// - delegatorHashes lists one delegate address per stored registration;
// - globalDelegationHashes[hash(delegator, collection, delegate, useCase)]
//   holds that delegate's registrations in the order they were made.
// A registration appends to both; a revocation removes the delegate from the
// first and deletes the second outright. So the delegate's entry count is how
// often it appears in the first list, and a block's registrations for that
// delegate are the last entries of the second, in log order.
//
// Each read costs at most O(list length) gas, so no delegator can grow its
// own lists until a read exceeds the eth_call gas cap and stalls the loop.

const DELEGATES_VIEW = 'retrieveDelegationAddresses';
const ENTRY_VIEW = 'globalDelegationHashes';
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
  tokenId: bigint;
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
  delegator: string;
  delegate: string;
  expiry: bigint;
  allTokens: boolean;
  tokenId: bigint;
}

export interface DelegationStateReader {
  /**
   * The delegator's delegate list for the collection and use case at the end
   * of `query.block`: one address per stored registration.
   */
  readDelegates(query: DelegationStateQuery): Promise<string[]>;
  /**
   * The delegator's registration for `delegate` at position `index` (in
   * registration order) at the end of `query.block`.
   */
  readEntry(
    query: DelegationStateQuery,
    delegate: string,
    index: number
  ): Promise<DelegationStateEntry>;
}

export type ContractCall = (
  to: string,
  data: string,
  blockTag: number
) => Promise<string>;

/** The key the contract uses for globalDelegationHashes. */
export function delegationGlobalHash(
  delegator: string,
  collection: string,
  delegate: string,
  useCase: number
): string {
  return solidityPackedKeccak256(
    ['address', 'address', 'address', 'uint256'],
    [delegator, collection, delegate, useCase]
  );
}

/** Reads contract state with `eth_call`. Throws when a call or decode fails. */
export function createDelegationStateReader(
  call: ContractCall,
  contractAddress: string
): DelegationStateReader {
  return {
    async readDelegates(query) {
      const data = DELEGATIONS_IFACE.encodeFunctionData(DELEGATES_VIEW, [
        query.delegator,
        query.collection,
        query.useCase
      ]);
      const raw = await call(contractAddress, data, query.block);
      const [delegates] = DELEGATIONS_IFACE.decodeFunctionResult(
        DELEGATES_VIEW,
        raw
      );
      return Array.from(delegates as string[]);
    },
    async readEntry(query, delegate, index) {
      const data = DELEGATIONS_IFACE.encodeFunctionData(ENTRY_VIEW, [
        delegationGlobalHash(
          query.delegator,
          query.collection,
          delegate,
          query.useCase
        ),
        index
      ]);
      const raw = await call(contractAddress, data, query.block);
      const result = DELEGATIONS_IFACE.decodeFunctionResult(ENTRY_VIEW, raw);
      return {
        delegator: result.delegatorAddress,
        delegate: result.delegationAddress,
        expiry: BigInt(result.expiryDate),
        allTokens: Boolean(result.allTokens),
        tokenId: BigInt(result.tokens)
      };
    }
  };
}

/**
 * Resolves the expiry of each registration. The result has one element per
 * input registration, in input order.
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
  reader: DelegationStateReader
): Promise<(number | null)[]> {
  const expiries: (number | null)[] = registrations.map(() => null);
  const groups = groupLiveRegistrations(registrations, revocations);

  const delegateLists = await mapInChunks(groups, (group) =>
    reader.readDelegates(group.query)
  );
  const reads = groups.reduce<EntryRead[]>(
    (all, group, i) => all.concat(planEntryReads(group, delegateLists[i])),
    []
  );
  const entries = await mapInChunks(reads, (read) =>
    reader.readEntry(read.query, read.member.registration.delegate, read.index)
  );
  reads.forEach((read, i) => {
    const { registration, index } = read.member;
    if (!matchesRegistration(registration, entries[i])) {
      throw new Error(
        `Stored registration ${read.index} does not match log ${registration.block}:${registration.logIndex} for delegate ${registration.delegate} on ${describeQuery(read.query)}`
      );
    }
    expiries[index] = toExpirySeconds(entries[i].expiry);
  });
  return expiries;
}

interface GroupMember {
  registration: RegistrationLogRef;
  index: number;
}

interface StateReadGroup {
  query: DelegationStateQuery;
  byDelegate: Map<string, GroupMember[]>;
}

interface EntryRead {
  query: DelegationStateQuery;
  member: GroupMember;
  index: number;
}

// Groups the registrations still held at the end of their block by block,
// delegator, collection and use case, then by delegate in log order.
function groupLiveRegistrations(
  registrations: RegistrationLogRef[],
  revocations: RevocationLogRef[]
): StateReadGroup[] {
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
        byDelegate: new Map()
      };
      groups.set(key, group);
    }
    const delegate = registration.delegate.toLowerCase();
    const members = group.byDelegate.get(delegate) ?? [];
    members.push({ registration, index });
    group.byDelegate.set(delegate, members);
  });

  const result = Array.from(groups.values());
  for (const group of result) {
    for (const members of Array.from(group.byDelegate.values())) {
      members.sort((a, b) => a.registration.logIndex - b.registration.logIndex);
    }
  }
  return result;
}

// Maps each registration to its position in the delegate's stored list: the
// block's registrations are its last entries, in log order.
function planEntryReads(
  group: StateReadGroup,
  delegateList: string[]
): EntryRead[] {
  const reads: EntryRead[] = [];
  for (const [delegate, members] of Array.from(group.byDelegate.entries())) {
    const stored = delegateList.filter(
      (address) => address.toLowerCase() === delegate
    ).length;
    if (stored < members.length) {
      throw new Error(
        `Expected ${members.length} stored registration(s) for delegate ${delegate} but found ${stored} for ${describeQuery(group.query)}`
      );
    }
    members.forEach((member, position) => {
      reads.push({
        query: group.query,
        member,
        index: stored - members.length + position
      });
    });
  }
  return reads;
}

// The contract stores token 0 for all-token registrations, whatever token id
// the caller passed.
function matchesRegistration(
  registration: RegistrationLogRef,
  entry: DelegationStateEntry
): boolean {
  if (
    entry.delegator.toLowerCase() !== registration.delegator.toLowerCase() ||
    entry.delegate.toLowerCase() !== registration.delegate.toLowerCase() ||
    entry.allTokens !== registration.allTokens
  ) {
    return false;
  }
  return registration.allTokens || entry.tokenId === registration.tokenId;
}

async function mapInChunks<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += STATE_READ_CONCURRENCY) {
    const chunk = items.slice(i, i + STATE_READ_CONCURRENCY);
    results.push(...(await Promise.all(chunk.map(fn))));
  }
  return results;
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
