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

const HEX20 = /^0x[0-9a-f]{40}$/;
const HEX32 = /^0x[0-9a-f]{64}$/;

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

/**
 * The AddressBinding writes and deletes of feed blocks at or below
 * `through`, in block order.
 */
export function bindingChangesOf(
  blocks: readonly ChainFeedBlock[],
  through = Number.POSITIVE_INFINITY
): BindingChange[] {
  const changes: BindingChange[] = [];
  for (const block of blocks) {
    if (block.height > through) continue;
    for (const record of block.records) {
      if (record.name !== 'AddressBinding') continue;
      const wallet = text(record.keyFields?.address);
      if (!HEX20.test(wallet)) continue;
      const principalId = text(record.valueFields?.principalId);
      changes.push({
        wallet,
        principalId:
          record.value === null || !HEX32.test(principalId)
            ? null
            : principalId,
        height: Number(block.height)
      });
    }
  }
  return changes;
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

/**
 * From a wallet's binding history (ascending changes): the height it has
 * been bound to `principalId` since, at or below `through`; null when the
 * history doesn't show it bound to that principal then.
 */
export function boundFromInHistory(
  changes: readonly { height: number; principalId: string | null }[],
  principalId: string,
  through: number
): number | null {
  let since: number | null = null;
  for (const change of changes) {
    if (Number(change.height) > through) break;
    const same = change.principalId?.toLowerCase() === principalId;
    if (!same) {
      since = null;
    } else if (since === null) {
      since = Number(change.height);
    }
  }
  return since;
}
