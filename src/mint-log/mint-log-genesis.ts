import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_PHOTO_TABLE,
  DISTRIBUTION_TABLE,
  MEME_CARD_DROP_MAPPINGS_TABLE,
  MEMES_CONTRACT,
  MINTING_CLAIM_ACTIONS_TABLE,
  MINTING_CLAIMS_TABLE,
  MINTING_MERKLE_ROOTS_TABLE
} from '@/constants';
import {
  NEXTGEN_ALLOWLIST_BURN_TABLE,
  NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE,
  NEXTGEN_ALLOWLIST_TABLE,
  NEXTGEN_BURN_COLLECTIONS_TABLE
} from '@/nextgen/nextgen_constants';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { ConnectionWrapper, dbSupplier, SqlExecutor } from '@/sql-executor';
import {
  MintColumnCatalog,
  quoteIdentifier,
  selectExpression
} from './mint-log-columns';
import { MintStateReader, mintStateReader } from './mint-log-capture';
import { mintCard, sortRows } from './mint-log-parts';
import { MintLogHeadDb, mintLogHeadDb } from './mint-log-head.db';
import { distributionCursorBlock } from './mint-log-inputs';
import type { MintRecordLogPort } from './mint-log-ports';
import { entrySha256 } from './mint-log-recorder';
import {
  MINT_LOG_ENTRY_VERSION,
  MINT_LOG_LANE,
  MintCardRef,
  MintCardState,
  MintLogEntryBody,
  MintRow,
  NEXTGEN_CARD_CONTRACT
} from './mint-log.types';
import { Time } from '@/time';

/**
 * The genesis: every card's rows as the shadow log starts, one gzipped
 * canonical JSON file per card on IPFS. Entry 0 of the mint log lists them.
 *
 * A genesis file also pins the normalized columns that later entries leave
 * out (minted counts, card name, mint date), since their history before the
 * log cannot be recomputed; with them goes the minted-count cursor block, so
 * a rebuild adds only the mints after it.
 */

export const GENESIS_FILE_VERSION = 1;

export interface MintGenesisFile {
  readonly v: typeof GENESIS_FILE_VERSION;
  readonly card: MintCardRef;
  readonly state: MintCardState;
  /** Key and pinned values of each normalized row. */
  readonly normalized_pinned: MintRow[];
}

export interface MintGenesisCard {
  readonly contract: string;
  readonly card_id: number;
  readonly cid: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface MintContentPort {
  /** Pins the bytes and returns their CID. */
  put(name: string, bytes: Buffer): Promise<string>;
  get(cid: string): Promise<Buffer>;
}

const PINNED_COLUMNS = [
  'card_id',
  'contract',
  'wallet',
  'minted',
  'total_count',
  'card_name',
  'mint_date'
];

export function encodeGenesisFile(file: MintGenesisFile): Buffer {
  return gzipSync(Buffer.from(canonicalizeJson(file), 'utf8'), { level: 9 });
}

export function decodeGenesisFile(
  bytes: Buffer,
  expected: MintGenesisCard
): MintGenesisFile {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected.sha256) {
    throw new Error(
      `Genesis file for ${expected.contract}#${expected.card_id} has sha256 ${sha256}, not ${expected.sha256}`
    );
  }
  const file = JSON.parse(
    gunzipSync(bytes).toString('utf8')
  ) as MintGenesisFile;
  if (
    file.v !== GENESIS_FILE_VERSION ||
    file.card.contract !== expected.contract ||
    file.card.card_id !== expected.card_id
  ) {
    throw new Error(
      `Genesis file for ${expected.contract}#${expected.card_id} names another card`
    );
  }
  return file;
}

export class MintGenesisReader {
  constructor(
    private readonly db: () => SqlExecutor = dbSupplier,
    private readonly reader: MintStateReader = mintStateReader,
    private readonly catalog: MintColumnCatalog = new MintColumnCatalog(db)
  ) {}

  /** Every card any minting table holds a row for. */
  async cards(connection: ConnectionWrapper<any>): Promise<MintCardRef[]> {
    const rows = await this.db().execute<{ contract: string; card_id: number }>(
      `select distinct lower(contract) as contract, card_id from ${DISTRIBUTION_TABLE}
       union select distinct lower(contract), card_id from ${DISTRIBUTION_NORMALIZED_TABLE}
       union select distinct lower(contract), card_id from ${DISTRIBUTION_PHOTO_TABLE}
       union select distinct lower(contract), card_id from ${MINTING_MERKLE_ROOTS_TABLE}
       union select distinct lower(contract), claim_id from ${MINTING_CLAIMS_TABLE}
       union select distinct lower(contract), claim_id from ${MINTING_CLAIM_ACTIONS_TABLE}
       union select lower(:memes), meme_card_id from ${MEME_CARD_DROP_MAPPINGS_TABLE}
       union select :nextgen, collection_id from ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}
       union select :nextgen, collection_id from ${NEXTGEN_ALLOWLIST_TABLE}
       union select :nextgen, collection_id from ${NEXTGEN_ALLOWLIST_BURN_TABLE}
       union select :nextgen, collection_id from ${NEXTGEN_BURN_COLLECTIONS_TABLE}`,
      { memes: MEMES_CONTRACT, nextgen: NEXTGEN_CARD_CONTRACT },
      { wrappedConnection: connection }
    );
    return rows
      .map((row) => mintCard(row.contract, Number(row.card_id)))
      .sort((a, b) =>
        a.contract === b.contract
          ? a.card_id - b.card_id
          : a.contract.localeCompare(b.contract)
      );
  }

  async file(
    card: MintCardRef,
    connection: ConnectionWrapper<any>
  ): Promise<MintGenesisFile> {
    const state = await this.reader.capture(card, connection);
    const columns = (
      await this.catalog.columns(DISTRIBUTION_NORMALIZED_TABLE, [], connection)
    ).filter((column) => PINNED_COLUMNS.includes(column.name));
    const pinned = await this.db().execute<MintRow>(
      `select ${columns.map(selectExpression).join(', ')}
       from ${quoteIdentifier(DISTRIBUTION_NORMALIZED_TABLE)}
       where contract = :contract and card_id = :card_id`,
      { contract: card.contract, card_id: card.card_id },
      { wrappedConnection: connection }
    );
    return {
      v: GENESIS_FILE_VERSION,
      card,
      state,
      normalized_pinned: sortRows(
        {
          part: 'normalized',
          table: DISTRIBUTION_NORMALIZED_TABLE,
          scope: '',
          key: ['card_id', 'contract', 'wallet'],
          excluded: [],
          mode: 'upsert'
        },
        pinned.map((row) => ({ ...row }))
      )
    };
  }
}

export const mintGenesisReader = new MintGenesisReader();

export interface MintGenesisRunDeps {
  readonly content: MintContentPort;
  readonly log: MintRecordLogPort;
  readonly db?: () => SqlExecutor;
  readonly genesis?: MintGenesisReader;
  readonly head?: MintLogHeadDb;
}

/**
 * Writes the genesis files and appends the genesis entry, holding the mint
 * log's lock throughout so no logged write falls between a card's file and
 * the entry. Run once, right after MINT_LOG_SHADOW is turned on: a logged
 * write that waits on the lock longer than the database's lock wait fails
 * before it changes anything, and can be retried.
 */
export async function runMintGenesis(
  deps: MintGenesisRunDeps
): Promise<MintLogEntryBody> {
  const db = deps.db ?? dbSupplier;
  const genesis = deps.genesis ?? mintGenesisReader;
  const head = deps.head ?? mintLogHeadDb;
  return db().executeNativeQueriesInTransaction(
    async (connection) => {
      const last = await head.lock(connection);
      const distributionCursor = await distributionCursorBlock(connection);
      const cards: MintGenesisCard[] = [];
      for (const card of await genesis.cards(connection)) {
        const bytes = encodeGenesisFile(await genesis.file(card, connection));
        const cid = await deps.content.put(
          `mint-genesis-${card.contract}-${card.card_id}.json.gz`,
          bytes
        );
        cards.push({
          contract: card.contract,
          card_id: card.card_id,
          cid,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length
        });
      }
      const entry: MintLogEntryBody = {
        v: MINT_LOG_ENTRY_VERSION,
        kind: 'mint.genesis',
        seq: last.seq + 1,
        prev: last.hash,
        at: Time.currentMillis(),
        card: null,
        actor: { type: 'service', wallet: null, authority: null },
        record_id: null,
        intent: { route: 'CLI mint-log:genesis', params: {}, body: null },
        inputs: { cards, distribution_cursor_block: distributionCursor },
        outputs: null,
        effects: {},
        checks: {
          undeclared: [],
          merkle_raw: [],
          replay: 'skipped',
          replay_mismatches: []
        },
        writer_error: null
      };
      await deps.log.append(
        [
          {
            t: 'entry',
            lane: MINT_LOG_LANE,
            chain: 'public',
            body: entry as unknown as Record<string, unknown>
          }
        ],
        { connection }
      );
      await head.advance(
        { seq: entry.seq, hash: entrySha256(entry) },
        connection
      );
      return entry;
    },
    // One snapshot for every read after the lock: the minted counts pinned in
    // the files and the cursor block they count up to come from the same
    // moment, even while the distribution loop commits.
    { isolationLevel: 'REPEATABLE READ' }
  );
}
