import { ChainFeedBlock } from '@/chain-gateway/chain-gateway.types';

/**
 * Which identity (principal) each wallet is bound to, and since which chain
 * height without a break: what record verifiers need to answer "the
 * principal of wallet W at height H" from 6529.io's own tables. The mirror
 * keeps it from the chain's AddressBinding records (the gateway's change
 * feed). Pure: the database layer reads and writes the rows.
 */

/** AddressBinding[address] = (principalId, via, cid, boundCycle, index). */
export const ADDRESS_BINDING_FAMILY = '0x0102';

/** A wallet address and a 32-byte id, lowercase hex. */
export const HEX20 = /^0x[0-9a-f]{40}$/;
export const HEX32 = /^0x[0-9a-f]{64}$/;

export interface BindingChange {
  readonly wallet: string;
  /** null: the wallet was unbound. */
  readonly principalId: string | null;
  readonly height: number;
}

export interface WalletBindingRow {
  readonly wallet: string;
  readonly principal_id: string;
  /** Bound to this principal from this height on, without a break. */
  readonly bound_from_height: number;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

export interface BindingPage {
  /** In block order. */
  readonly changes: BindingChange[];
  /** Records that could not be read (`height:key`). */
  readonly malformed: string[];
  /**
   * The first block with a record whose wallet can't be read: the page's
   * changes stop before it, and the bindings must not read past it.
   */
  readonly stoppedAt: number | null;
}

/**
 * The AddressBinding writes and deletes of feed blocks, in block order. A
 * write whose principal can't be read drops the wallet's row (a lookup then
 * asks the chain), never keeps an old one; a record whose wallet can't be
 * read stops the page at its block.
 */
export function bindingChangesOf(
  blocks: readonly ChainFeedBlock[]
): BindingPage {
  const changes: BindingChange[] = [];
  const malformed: string[] = [];
  for (const block of blocks) {
    const height = Number(block.height);
    const records = block.records.filter(
      (it) => it.family.toLowerCase() === ADDRESS_BINDING_FAMILY
    );
    const unreadable = records.filter(
      (it) => !HEX20.test(text(it.keyFields?.address))
    );
    if (unreadable.length) {
      malformed.push(...unreadable.map((it) => `${height}:${it.key}`));
      return { changes, malformed, stoppedAt: height };
    }
    for (const record of records) {
      const change = toBindingChange(height, record);
      if (change.unreadable) malformed.push(`${height}:${record.key}`);
      changes.push(change.change);
    }
  }
  return { changes, malformed, stoppedAt: null };
}

function toBindingChange(
  height: number,
  record: ChainFeedBlock['records'][number]
): { change: BindingChange; unreadable: boolean } {
  const wallet = text(record.keyFields?.address);
  if (record.value === null) {
    return { change: { wallet, principalId: null, height }, unreadable: false };
  }
  const principalId = text(record.valueFields?.principalId);
  return HEX32.test(principalId)
    ? { change: { wallet, principalId, height }, unreadable: false }
    : { change: { wallet, principalId: null, height }, unreadable: true };
}

/**
 * The stored bindings after `changes`, in order: a wallet that moves to
 * another principal starts a new bound-from height; a write that keeps its
 * principal (another field of the binding changed) keeps it; an unbinding
 * removes the row. Returns only the rows that differ from `stored`.
 */
export function foldBindings(
  stored: ReadonlyMap<string, WalletBindingRow>,
  changes: readonly BindingChange[]
): { upserts: WalletBindingRow[]; deletes: string[] } {
  const next = new Map<string, WalletBindingRow | null>();
  for (const change of changes) {
    const current = next.has(change.wallet)
      ? next.get(change.wallet)
      : stored.get(change.wallet);
    if (change.principalId === null) {
      next.set(change.wallet, null);
    } else if (current?.principal_id !== change.principalId) {
      next.set(change.wallet, {
        wallet: change.wallet,
        principal_id: change.principalId,
        bound_from_height: change.height
      });
    }
  }
  const upserts: WalletBindingRow[] = [];
  const deletes: string[] = [];
  next.forEach((row, wallet) => {
    const before = stored.get(wallet);
    if (row === null) {
      if (before) deletes.push(wallet);
    } else if (
      before?.principal_id !== row.principal_id ||
      Number(before.bound_from_height) !== row.bound_from_height
    ) {
      upserts.push(row);
    }
  });
  return { upserts, deletes };
}
