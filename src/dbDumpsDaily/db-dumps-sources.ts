import {
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  NFTDELEGATION_BLOCKS_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { ConnectionWrapper, sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';

// The identity mirror's state row, from the identity mirror's own entity
// (identity_chain_mirror_state, id 'identity'). Read only; never dumped.
const MIRROR_STATE_TABLE = 'identity_chain_mirror_state';
// A mirror that hasn't moved for longer than this isn't following the chain.
const MIRROR_FRESH_MILLIS = Time.minutes(30).toMillis();

/** Where a dumped table's rows come from, named in the manifest. */
export type DumpSource =
  | { readonly kind: 'ethereum'; readonly max_block: number | null }
  | { readonly kind: 'nftdelegation'; readonly last_block: number | null }
  | {
      readonly kind: 'identity_chain_mirror';
      /**
       * The next finalized 6529 chain height the mirror will read: every
       * height below it was applied when the rows were read. The mirror
       * saves this after a page's rows, so the rows can also hold part of
       * the page from this height on, never less than the heights below it.
       */
      readonly next_height: number;
      /** When the mirror last moved, Unix milliseconds. */
      readonly updated_at: number;
    };

export type TableRead =
  | {
      readonly table: string;
      readonly rows: Record<string, unknown>[];
      readonly source: DumpSource;
    }
  | { readonly table: string; readonly skip: string };

interface MirrorState {
  readonly next_height: number | string | null;
  readonly sync_phase: string | null;
  readonly updated_at: number | string;
}

type Read = <T>(sql: string) => Promise<T[]>;

async function readMirrorState(read: Read): Promise<MirrorState | null> {
  try {
    const rows = await read<MirrorState>(
      `SELECT next_height, sync_phase, updated_at FROM ${MIRROR_STATE_TABLE} WHERE id = 'identity'`
    );
    return rows[0] ?? null;
  } catch (error) {
    // Before the identity mirror is deployed its table doesn't exist.
    if ((error as { code?: string }).code === 'ER_NO_SUCH_TABLE') return null;
    throw error;
  }
}

function blockOf(rows: { block: number | string | null }[]): number | null {
  const block = rows[0]?.block;
  return block === null || block === undefined ? null : Number(block);
}

/** Runs `work` in one REPEATABLE READ transaction: one snapshot for all reads. */
async function inOneSnapshot<T>(work: (read: Read) => Promise<T>): Promise<T> {
  return sqlExecutor.executeNativeQueriesInTransaction(
    (connection: ConnectionWrapper<any>) =>
      work(<R>(sql: string) =>
        sqlExecutor.execute<R>(sql, undefined, {
          wrappedConnection: connection
        })
      ),
    { isolationLevel: 'REPEATABLE READ' }
  );
}

/**
 * Delegations and consolidations, read with the identity mirror's state in
 * one snapshot, so the files and the height the manifest names belong
 * together however the mirror moves during the dump. Before the mirror runs
 * they come from NFTDelegation. While the mirror is part way through a full
 * pass, hasn't passed once, or has stopped moving, both are skipped: the
 * previous files stay, and a later run dumps them.
 */
export async function readChainTables(
  now: number,
  afterSnapshot: () => Promise<void> = async () => undefined
): Promise<TableRead[]> {
  return inOneSnapshot(async (read) => {
    const mirror = await readMirrorState(read);
    // Tests change the mirror here, after the snapshot is taken.
    await afterSnapshot();
    let source: DumpSource | string;
    if (!mirror) {
      source = {
        kind: 'nftdelegation',
        last_block: blockOf(
          await read(
            `SELECT MAX(block) AS block FROM ${NFTDELEGATION_BLOCKS_TABLE}`
          )
        )
      };
    } else if (mirror.next_height === null || mirror.sync_phase !== null) {
      source = 'the identity mirror has not finished a full pass';
    } else if (now - Number(mirror.updated_at) > MIRROR_FRESH_MILLIS) {
      source = 'the identity mirror has not moved for 30 minutes';
    } else {
      source = {
        kind: 'identity_chain_mirror',
        next_height: Number(mirror.next_height),
        updated_at: Number(mirror.updated_at)
      };
    }
    if (typeof source === 'string') {
      const skip = source;
      return [DELEGATIONS_TABLE, CONSOLIDATIONS_TABLE].map((table) => ({
        table,
        skip
      }));
    }
    return [
      {
        table: DELEGATIONS_TABLE,
        rows: await read<Record<string, unknown>>(
          `SELECT * FROM ${DELEGATIONS_TABLE}`
        ),
        source
      },
      {
        table: CONSOLIDATIONS_TABLE,
        rows: await read<Record<string, unknown>>(
          `SELECT * FROM ${CONSOLIDATIONS_TABLE}`
        ),
        source
      }
    ];
  });
}

/** The transactions, with the highest block, in one snapshot. */
export async function readTransactions(): Promise<TableRead> {
  return inOneSnapshot(async (read) => {
    const max_block = blockOf(
      await read(`SELECT MAX(block) AS block FROM ${TRANSACTIONS_TABLE}`)
    );
    return {
      table: TRANSACTIONS_TABLE,
      rows: await read<Record<string, unknown>>(
        `SELECT * FROM ${TRANSACTIONS_TABLE}`
      ),
      source: { kind: 'ethereum', max_block }
    };
  });
}
