import {
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  NFTDELEGATION_BLOCKS_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { Time } from '@/time';

type Query = <T>(sql: string) => Promise<T[]>;

// The identity mirror's state row, from the identity mirror's own entity
// (identity_chain_mirror_state, id 'identity'). Read only.
const MIRROR_STATE_TABLE = 'identity_chain_mirror_state';
// A mirror that hasn't moved for longer than this isn't following the chain.
const MIRROR_FRESH_MILLIS = Time.minutes(30).toMillis();

/** Where a dumped table's rows come from, named in the manifest. */
export type DumpSource =
  | { readonly kind: 'ethereum'; readonly max_block: number | null }
  | { readonly kind: 'nftdelegation'; readonly last_block: number | null }
  | {
      readonly kind: 'identity_chain_mirror';
      /** The next finalized 6529 chain height the mirror will read. */
      readonly next_height: number;
      /** When the mirror last moved, Unix milliseconds. */
      readonly updated_at: number;
    };

export type DumpPlan =
  | { readonly table: string; readonly source: DumpSource }
  | { readonly table: string; readonly skip: string };

interface MirrorState {
  readonly next_height: number | string | null;
  readonly sync_phase: string | null;
  readonly updated_at: number | string;
}

async function readMirrorState(query: Query): Promise<MirrorState | null> {
  try {
    const rows = await query<MirrorState>(
      `SELECT next_height, sync_phase, updated_at FROM ${MIRROR_STATE_TABLE} WHERE id = 'identity'`
    );
    return rows[0] ?? null;
  } catch (error) {
    // Before the identity mirror is deployed its table doesn't exist.
    if ((error as { code?: string }).code === 'ER_NO_SUCH_TABLE') return null;
    throw error;
  }
}

async function maxBlock(query: Query, table: string): Promise<number | null> {
  const [row] = await query<{ block: number | string | null }>(
    `SELECT MAX(block) AS block FROM ${table}`
  );
  return row?.block === null || row?.block === undefined
    ? null
    : Number(row.block);
}

/**
 * The source of each dumped table. Delegations and consolidations come from
 * NFTDelegation until the identity mirror runs, then from the mirror. While
 * the mirror is part way through a full pass, hasn't passed once, or has
 * stopped moving, those two tables are skipped: the previous files stay, and
 * a later run dumps them.
 */
export async function planDumps(
  query: Query,
  tables: readonly string[],
  now: number
): Promise<DumpPlan[]> {
  const mirror = await readMirrorState(query);
  let chainSource: DumpSource | string;
  if (!mirror) {
    chainSource = {
      kind: 'nftdelegation',
      last_block: await maxBlock(query, NFTDELEGATION_BLOCKS_TABLE)
    };
  } else if (mirror.next_height === null || mirror.sync_phase !== null) {
    chainSource = 'the identity mirror has not finished a full pass';
  } else if (now - Number(mirror.updated_at) > MIRROR_FRESH_MILLIS) {
    chainSource = 'the identity mirror has not moved for 30 minutes';
  } else {
    chainSource = {
      kind: 'identity_chain_mirror',
      next_height: Number(mirror.next_height),
      updated_at: Number(mirror.updated_at)
    };
  }
  const ethereum: DumpSource = {
    kind: 'ethereum',
    max_block: await maxBlock(query, TRANSACTIONS_TABLE)
  };
  return tables.map((table) => {
    if (table === TRANSACTIONS_TABLE) return { table, source: ethereum };
    if (table === DELEGATIONS_TABLE || table === CONSOLIDATIONS_TABLE) {
      return typeof chainSource === 'string'
        ? { table, skip: chainSource }
        : { table, source: chainSource };
    }
    throw new Error(`No dump source known for ${table}`);
  });
}
