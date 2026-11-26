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
  MEME_COLLABORATION_INVITATIONS_TABLE,
  MEME_COLLABORATIONS_TABLE,
  REMEMES_TABLE,
  REMEMES_UPLOADS,
  ROYALTIES_UPLOADS_TABLE
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
import { compareText, mintCard, sortRows } from './mint-log-parts';
import {
  MintLogHead,
  MintLogHeadDb,
  mintHeadKey,
  mintLogHeadDb
} from './mint-log-head.db';
import { distributionCursorBlock } from './mint-log-inputs';
import type { MintRecordLogPort } from './mint-log-ports';
import { entrySha256 } from './mint-log-recorder';
import {
  chainOfCard,
  MINT_LOG_ENTRY_VERSION,
  MINT_LOG_LANE,
  MintCardRef,
  MintLogChain,
  MintCardState,
  MintLogEntryBody,
  MintRow,
  COLLAB_CARD_CONTRACT,
  NEXTGEN_CARD_CONTRACT,
  REMEMES_CARD_CONTRACT,
  UPLOADS_CARD_CONTRACT
} from './mint-log.types';
import { Time } from '@/time';

/**
 * The genesis: every card's rows as the shadow log starts, one gzipped
 * canonical JSON file per card on IPFS, listed by a genesis entry of the
 * card's chain.
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
  readonly key?: string;
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

/** A card's name in file names and messages. */
export function cardName(card: {
  readonly contract: string;
  readonly card_id: number;
  readonly key?: string;
}): string {
  return card.key === undefined
    ? `${card.contract}-${card.card_id}`
    : `${card.contract}-${card.key}`;
}

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
      `Genesis file for ${cardName(expected)} has sha256 ${sha256}, not ${expected.sha256}`
    );
  }
  const file = JSON.parse(
    gunzipSync(bytes).toString('utf8')
  ) as MintGenesisFile;
  if (
    file.v !== GENESIS_FILE_VERSION ||
    file.card.contract !== expected.contract ||
    file.card.card_id !== expected.card_id ||
    (file.card.key ?? null) !== (expected.key ?? null)
  ) {
    throw new Error(
      `Genesis file for ${cardName(expected)} names another card`
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
    const rows = await this.db().execute<{
      contract: string;
      card_id: number;
      card_key: string | null;
    }>(
      `select contract, card_id, card_key from (
       select distinct lower(contract) as contract, card_id, null as card_key from ${DISTRIBUTION_TABLE}
       union select distinct lower(contract), card_id, null from ${DISTRIBUTION_NORMALIZED_TABLE}
       union select distinct lower(contract), card_id, null from ${DISTRIBUTION_PHOTO_TABLE}
       union select distinct lower(contract), card_id, null from ${MINTING_MERKLE_ROOTS_TABLE}
       union select distinct lower(contract), claim_id, null from ${MINTING_CLAIMS_TABLE}
       union select distinct lower(contract), claim_id, null from ${MINTING_CLAIM_ACTIONS_TABLE}
       union select lower(:memes), meme_card_id, null from ${MEME_CARD_DROP_MAPPINGS_TABLE}
       union select :nextgen, collection_id, null from ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}
       union select :nextgen, collection_id, null from ${NEXTGEN_ALLOWLIST_TABLE}
       union select :nextgen, collection_id, null from ${NEXTGEN_ALLOWLIST_BURN_TABLE}
       union select :nextgen, collection_id, null from ${NEXTGEN_BURN_COLLECTIONS_TABLE}
       union select distinct :rememes, 0, lower(contract) from ${REMEMES_TABLE}
       union select distinct :collab, 0, drop_id from ${MEME_COLLABORATIONS_TABLE}
       union select distinct :collab, 0, drop_id from ${MEME_COLLABORATION_INVITATIONS_TABLE}
       union select :uploads, 0, :rememe_uploads
       union select :uploads, 0, :royalties_uploads
       ) as cards`,
      {
        memes: MEMES_CONTRACT,
        nextgen: NEXTGEN_CARD_CONTRACT,
        rememes: REMEMES_CARD_CONTRACT,
        collab: COLLAB_CARD_CONTRACT,
        uploads: UPLOADS_CARD_CONTRACT,
        rememe_uploads: REMEMES_UPLOADS,
        royalties_uploads: ROYALTIES_UPLOADS_TABLE
      },
      { wrappedConnection: connection }
    );
    return rows
      .map((row) =>
        mintCard(row.contract, Number(row.card_id), row.card_key ?? undefined)
      )
      .sort(
        (a, b) =>
          compareText(a.contract, b.contract) ||
          a.card_id - b.card_id ||
          compareText(a.key ?? '', b.key ?? '')
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
  /** The chains to write a genesis for; all of them when absent. */
  readonly chains?: readonly MintLogChain[];
}

export const GENESIS_CHAINS: readonly MintLogChain[] = [
  'mint',
  'rememes',
  'collab'
];

/**
 * Writes the genesis files and appends the genesis entries. The token chain
 * and the rememes chain get one entry each that lists all their cards; each
 * holds its chain's head throughout, so no logged write falls between a
 * card's file and the entry. A collaboration gets an entry of its own, which
 * holds its collaboration row and its head, as its writes do.
 *
 * Run once, right after MINT_LOG_SHADOW is turned on: a logged write that
 * waits on a head longer than the database's lock wait fails before it
 * changes anything, and can be retried.
 */
export async function runMintGenesis(
  deps: MintGenesisRunDeps
): Promise<MintLogEntryBody[]> {
  const chains = deps.chains ?? GENESIS_CHAINS;
  const entries: MintLogEntryBody[] = [];
  for (const chain of chains.filter((it) => it !== 'collab')) {
    entries.push(await chainGenesis(deps, chain));
  }
  if (chains.includes('collab')) {
    const db = deps.db ?? dbSupplier;
    const genesis = deps.genesis ?? mintGenesisReader;
    const cards = await db().executeNativeQueriesInTransaction(
      async (connection) =>
        (await genesis.cards(connection)).filter(
          (card) => chainOfCard(card) === 'collab'
        )
    );
    for (const card of cards) {
      entries.push(await collaborationGenesis(deps, card));
    }
  }
  return entries;
}

async function chainGenesis(
  deps: MintGenesisRunDeps,
  chain: MintLogChain
): Promise<MintLogEntryBody> {
  const db = deps.db ?? dbSupplier;
  const genesis = deps.genesis ?? mintGenesisReader;
  const head = deps.head ?? mintLogHeadDb;
  return db().executeNativeQueriesInTransaction(
    async (connection) => {
      const key = mintHeadKey(chain, null);
      const last = await head.lock(connection, key);
      const inputs: Record<string, unknown> = {};
      if (chain === 'mint') {
        inputs.distribution_cursor_block =
          await distributionCursorBlock(connection);
      }
      const cards = (await genesis.cards(connection)).filter(
        (card) => chainOfCard(card) === chain
      );
      inputs.cards = await writeFiles(deps, genesis, cards, connection);
      return appendGenesis(deps, head, connection, {
        chain,
        card: null,
        last,
        inputs,
        key
      });
    },
    // One snapshot for every read after the lock: the minted counts pinned in
    // the files and the cursor block they count up to come from the same
    // moment, even while the distribution loop commits.
    { isolationLevel: 'REPEATABLE READ' }
  );
}

async function collaborationGenesis(
  deps: MintGenesisRunDeps,
  card: MintCardRef
): Promise<MintLogEntryBody> {
  const db = deps.db ?? dbSupplier;
  const genesis = deps.genesis ?? mintGenesisReader;
  const head = deps.head ?? mintLogHeadDb;
  return db().executeNativeQueriesInTransaction(
    async (connection) => {
      // The writers lock this row before the head; so does the genesis.
      await db().execute(
        `select drop_id from ${MEME_COLLABORATIONS_TABLE} where drop_id = :drop_id for update`,
        { drop_id: card.key },
        { wrappedConnection: connection }
      );
      const key = mintHeadKey('collab', card);
      const last = await head.lock(connection, key);
      const cards = await writeFiles(deps, genesis, [card], connection);
      return appendGenesis(deps, head, connection, {
        chain: 'collab',
        card,
        last,
        inputs: { cards },
        key
      });
    },
    // Reads see every write committed before the locks.
    { isolationLevel: 'READ COMMITTED' }
  );
}

async function writeFiles(
  deps: MintGenesisRunDeps,
  genesis: MintGenesisReader,
  cards: readonly MintCardRef[],
  connection: ConnectionWrapper<any>
): Promise<MintGenesisCard[]> {
  const listed: MintGenesisCard[] = [];
  for (const card of cards) {
    const bytes = encodeGenesisFile(await genesis.file(card, connection));
    const cid = await deps.content.put(
      `mint-genesis-${cardName(card).replace(/[^a-z0-9-]/gi, '-')}.json.gz`,
      bytes
    );
    listed.push({
      contract: card.contract,
      card_id: card.card_id,
      ...(card.key === undefined ? {} : { key: card.key }),
      cid,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length
    });
  }
  return listed;
}

async function appendGenesis(
  deps: MintGenesisRunDeps,
  head: MintLogHeadDb,
  connection: ConnectionWrapper<any>,
  genesis: {
    readonly chain: MintLogChain;
    readonly card: MintCardRef | null;
    readonly last: MintLogHead;
    readonly inputs: Record<string, unknown>;
    readonly key: string;
  }
): Promise<MintLogEntryBody> {
  const entry: MintLogEntryBody = {
    v: MINT_LOG_ENTRY_VERSION,
    kind: 'mint.genesis',
    chain: genesis.chain,
    seq: genesis.last.seq + 1,
    prev: genesis.last.hash,
    at: Time.currentMillis(),
    card: genesis.card,
    actor: { type: 'service', wallet: null, authority: null },
    record_id: null,
    intent: { route: 'CLI mint-log:genesis', params: {}, body: null },
    inputs: genesis.inputs,
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
    connection,
    genesis.key
  );
  return entry;
}
