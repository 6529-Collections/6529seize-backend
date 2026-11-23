import fc from 'fast-check';
import { ChainFeedBlock } from '@/chain-gateway/chain-gateway.types';
import {
  bindingChangesOf,
  foldBindings,
  WalletBindingRow
} from './wallet-bindings';

/**
 * A model of the bindings table: random binding histories, read in pages
 * of random size, sometimes rebuilt from a membership list at a random
 * height. After every step, every wallet bound at the last height read has
 * a row, and each row's bound-from height is exactly the start of the
 * wallet's unbroken binding, or the rebuild's height when that came later.
 */

const WALLETS = [1, 2, 3].map((n) => `0x${n.toString(16).padStart(40, '0')}`);
const PRINCIPALS = [1, 2].map((n) => `0x${n.toString(16).padStart(64, '0')}`);
const LAST = 40;

type Event = { height: number; wallet: number; principal: number | null };

function blocksOf(events: Event[]): ChainFeedBlock[] {
  const byHeight = new Map<number, Map<number, number | null>>();
  for (const event of events) {
    const block = byHeight.get(event.height) ?? new Map();
    block.set(event.wallet, event.principal);
    byHeight.set(event.height, block);
  }
  return Array.from(byHeight.entries())
    .sort(([a], [b]) => a - b)
    .map(([height, changes]) => ({
      height,
      slot: height,
      root: '0x',
      time: height,
      records: Array.from(changes.entries()).map(([wallet, principal]) => ({
        family: '0x0102',
        name: 'AddressBinding',
        key: `0x${wallet}`,
        value: principal === null ? null : '0x01',
        keyFields: { address: WALLETS[wallet] },
        valueFields:
          principal === null ? null : { principalId: PRINCIPALS[principal] }
      }))
    }));
}

/** The truth: a wallet's principal at a height, from the blocks. */
function truth(
  blocks: ChainFeedBlock[],
  wallet: string,
  height: number
): string | null {
  let principal: string | null = null;
  for (const block of blocks) {
    if (block.height > height) break;
    for (const record of block.records) {
      if (record.keyFields?.address !== wallet) continue;
      principal =
        record.value === null
          ? null
          : String(record.valueFields?.principalId ?? '');
    }
  }
  return principal;
}

/** The start of the wallet's unbroken binding at `height`, if bound. */
function boundSince(
  blocks: ChainFeedBlock[],
  wallet: string,
  height: number
): number | null {
  const principal = truth(blocks, wallet, height);
  if (principal === null) return null;
  let since = height;
  while (since > 1 && truth(blocks, wallet, since - 1) === principal) since--;
  return since;
}

function checkRows(
  rows: Map<string, WalletBindingRow>,
  blocks: ChainFeedBlock[],
  nextHeight: number,
  rebuiltAt: number | null
) {
  const last = nextHeight - 1;
  for (const wallet of WALLETS) {
    const principal = last >= 1 ? truth(blocks, wallet, last) : null;
    const row = rows.get(wallet) ?? null;
    if (principal === null) {
      expect([wallet, row]).toEqual([wallet, null]);
      continue;
    }
    const since = boundSince(blocks, wallet, last)!;
    expect([wallet, row]).toEqual([
      wallet,
      {
        wallet,
        principal_id: principal,
        bound_from_height:
          rebuiltAt !== null && since <= rebuiltAt ? rebuiltAt : since
      }
    ]);
  }
}

const events = fc.array(
  fc.record({
    height: fc.integer({ min: 1, max: LAST }),
    wallet: fc.integer({ min: 0, max: WALLETS.length - 1 }),
    principal: fc.option(fc.integer({ min: 0, max: PRINCIPALS.length - 1 }))
  }),
  { maxLength: 60 }
);

describe('the wallet bindings model', () => {
  it('never claims a binding where there was none, page by page', () => {
    fc.assert(
      fc.property(
        events,
        fc.array(fc.integer({ min: 1, max: 12 }), {
          minLength: 1,
          maxLength: 20
        }),
        fc.option(fc.integer({ min: 1, max: LAST })),
        (history, pageSizes, rebuildAt) => {
          const blocks = blocksOf(history);
          const rows = new Map<string, WalletBindingRow>();
          let next = 1;
          let pages = 0;
          let rebuiltAt: number | null = null;
          while (next <= LAST) {
            if (rebuildAt !== null && next <= rebuildAt && pages === 2) {
              // The feed is gone: list the membership at rebuildAt.
              rows.clear();
              for (const wallet of WALLETS) {
                const principal = truth(blocks, wallet, rebuildAt);
                if (principal) {
                  rows.set(wallet, {
                    wallet,
                    principal_id: principal,
                    bound_from_height: rebuildAt
                  });
                }
              }
              next = rebuildAt + 1;
              rebuiltAt = rebuildAt;
            } else {
              const size = pageSizes[pages % pageSizes.length];
              const through = Math.min(LAST, next + size - 1);
              const page = bindingChangesOf(
                blocks.filter((it) => it.height >= next && it.height <= through)
              );
              const { upserts, deletes } = foldBindings(rows, page.changes);
              deletes.forEach((it) => rows.delete(it));
              upserts.forEach((it) => rows.set(it.wallet, it));
              next = through + 1;
            }
            pages++;
            checkRows(rows, blocks, next, rebuiltAt);
          }
        }
      ),
      { numRuns: 300 }
    );
  });
});
