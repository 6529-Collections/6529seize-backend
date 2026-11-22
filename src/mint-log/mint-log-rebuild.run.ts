import {
  MINT_LOG_CARD_HEADS_TABLE,
  MINT_LOG_HEAD_TABLE,
  MINTING_MERKLE_PROOFS_TABLE,
  MINTING_MERKLE_ROOTS_TABLE
} from '@/constants';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { dbSupplier, SqlExecutor } from '@/sql-executor';
import { quoteIdentifier } from './mint-log-columns';
import { ipfsMintContent } from './mint-log-content';
import type { MintContentPort } from './mint-log-genesis';
import { MINT_ROW_PART_SPECS } from './mint-log-parts';
import { MintLogRebuilder, MintRebuildResult } from './mint-log-rebuild';
import { MINT_LOG_LANE, MintLogEntryBody } from './mint-log.types';

/** What the rebuild reads the shared record log through. */
export interface MintRecordLogSource {
  walk(chain: 'public'): AsyncIterable<{ readonly entry: RecordLogEntry }>;
}

let recordLogSource: (() => MintRecordLogSource) | null = null;

/**
 * Binds how a rebuild reads the record log: the signed-records module's
 * RecordLogReader over the records wave (read through the relays) and the
 * files source. Until it is bound the rebuild step says so and stops.
 */
export function setMintRecordLogSource(
  source: (() => MintRecordLogSource) | null
): void {
  recordLogSource = source;
}

/** The mint log's entries (lane `mint`) of the public chain, in log order. */
export async function* mintLogEntries(
  items: AsyncIterable<{ readonly entry: RecordLogEntry }>
): AsyncGenerator<MintLogEntryBody> {
  for await (const item of items) {
    const entry = item.entry as {
      readonly t?: string;
      readonly lane?: string;
      readonly body?: unknown;
    };
    if (entry.t === 'entry' && entry.lane === MINT_LOG_LANE) {
      yield entry.body as MintLogEntryBody;
    }
  }
}

/** Every table the mint log writes whole (not the subscription phases). */
export function mintRebuiltTables(): string[] {
  const parts = Object.values(MINT_ROW_PART_SPECS)
    .filter((spec) => spec.mode !== 'update-only')
    .map((spec) => spec.table);
  return Array.from(
    new Set([
      ...parts,
      MINTING_MERKLE_ROOTS_TABLE,
      MINTING_MERKLE_PROOFS_TABLE,
      MINT_LOG_HEAD_TABLE,
      MINT_LOG_CARD_HEADS_TABLE
    ])
  ).sort((a, b) => a.localeCompare(b));
}

/** A rebuild starts from empty tables; it never writes over live rows. */
export async function assertMintTablesEmpty(
  db: () => SqlExecutor = dbSupplier
): Promise<void> {
  const holding: string[] = [];
  for (const table of mintRebuiltTables()) {
    const rows = await db().execute(
      `select 1 from ${quoteIdentifier(table)} limit 1`
    );
    if (rows.length) holding.push(table);
  }
  if (holding.length) {
    throw new Error(
      `The mint log rebuilds into empty tables; these hold rows: ${holding.join(', ')}`
    );
  }
}

/** Replays the record log's mint entries into empty tables. */
export async function rebuildMintLogFromRecordLog(deps: {
  readonly source: MintRecordLogSource;
  readonly content: MintContentPort;
  readonly db?: () => SqlExecutor;
}): Promise<MintRebuildResult> {
  const db = deps.db ?? dbSupplier;
  await assertMintTablesEmpty(db);
  return new MintLogRebuilder(deps.content, db).rebuild(
    mintLogEntries(deps.source.walk('public'))
  );
}

/**
 * The rebuild step: reads the record log through the bound source and the
 * genesis files from the files source (MINT_LOG_FILES_URL). The step
 * context is not needed.
 */
export async function rebuildMintLog(): Promise<void> {
  if (!recordLogSource) {
    throw new Error(
      'No record log source is bound: the rebuild needs the records wave reader'
    );
  }
  await rebuildMintLogFromRecordLog({
    source: recordLogSource(),
    content: ipfsMintContent()
  });
}
