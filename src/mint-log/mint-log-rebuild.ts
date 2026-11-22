import {
  DISTRIBUTION_NORMALIZED_TABLE,
  MANIFOLD,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE,
  MEMELAB_CONTRACT,
  NULL_ADDRESS,
  TRANSACTIONS_TABLE
} from '@/constants';
import { Logger } from '@/logging';
import { ConnectionWrapper, dbSupplier, SqlExecutor } from '@/sql-executor';
import { MintStateWriter, mintStateWriter } from './mint-log-apply';
import { MintStateReader, mintStateReader } from './mint-log-capture';
import { diffCardState } from './mint-log-diff';
import {
  decodeGenesisFile,
  MintContentPort,
  MintGenesisCard
} from './mint-log-genesis';
import { MintLogHeadDb, mintLogHeadDb } from './mint-log-head.db';
import { mintCard, MintRowPartSpec } from './mint-log-parts';
import { entrySha256 } from './mint-log-recorder';
import type { MintCardRef, MintLogEntryBody } from './mint-log.types';

const logger = Logger.get('MINT_LOG_REBUILD');

/** Pinned normalized columns from a genesis file, written onto its rows. */
const PINNED_SPEC: MintRowPartSpec = {
  part: 'normalized',
  table: DISTRIBUTION_NORMALIZED_TABLE,
  scope: 'contract = :contract and card_id = :card_id',
  key: ['card_id', 'contract', 'wallet'],
  excluded: [
    'airdrops',
    'total_spots',
    'allowlist',
    'phases',
    'wallet_display'
  ],
  only: [
    'card_id',
    'contract',
    'wallet',
    'minted',
    'total_count',
    'card_name',
    'mint_date'
  ],
  mode: 'update-only'
};

export interface MintRebuildResult {
  readonly entries: number;
  readonly cards: number;
  readonly head: { seq: number; hash: string } | null;
}

/** Where minted counts restart for a card: a block, and pinned counts or zero. */
interface MintedBase {
  readonly block: number;
  readonly pinned: boolean;
}

function cardKey(card: MintCardRef): string {
  return `${card.contract}#${card.card_id}`;
}

/**
 * Rebuilds the minting tables from empty: the genesis files, then every mint
 * entry in log order through the reducer the live writes were checked with.
 * Then the columns the log leaves out are derived again:
 * - minted counts: paid mints from Manifold or the null address to the wallet
 *   after the block where they last restarted (a normalize, or the genesis,
 *   whose pinned counts they add to), as the distribution loop counts them;
 * - card name and mint date from the NFT index, where a normalize left them
 *   empty, as the NFT loop fills them.
 */
export class MintLogRebuilder {
  constructor(
    private readonly content: MintContentPort,
    private readonly db: () => SqlExecutor = dbSupplier,
    private readonly reader: MintStateReader = mintStateReader,
    private readonly writer: MintStateWriter = mintStateWriter,
    private readonly head: MintLogHeadDb = mintLogHeadDb
  ) {}

  async rebuild(
    entries: AsyncIterable<MintLogEntryBody> | Iterable<MintLogEntryBody>
  ): Promise<MintRebuildResult> {
    const bases = new Map<string, { card: MintCardRef; base: MintedBase }>();
    let previous: { seq: number; hash: string } | null = null;
    let count = 0;
    for await (const entry of entries) {
      this.assertChain(entry, previous);
      await this.db().executeNativeQueriesInTransaction(async (connection) => {
        if (entry.kind === 'mint.genesis') {
          await this.applyGenesis(entry, bases, connection);
        } else if (entry.card) {
          await this.writer.apply(entry.card, entry.effects, connection);
          // A normalize restarts every minted count of the card at zero,
          // even when the rows it rewrote are otherwise unchanged.
          if (entry.kind === 'dist.normalize' && !entry.writer_error) {
            const block = Number(entry.inputs.distribution_cursor_block ?? 0);
            bases.set(cardKey(entry.card), {
              card: entry.card,
              base: { block, pinned: false }
            });
          }
        }
      });
      previous = { seq: entry.seq, hash: entrySha256(entry) };
      count++;
    }
    await this.db().executeNativeQueriesInTransaction(async (connection) => {
      for (const { card, base } of Array.from(bases.values())) {
        await this.deriveMinted(card, base, connection);
        await this.deriveCardInfo(card, connection);
      }
      if (previous) {
        await this.head.lock(connection);
        await this.head.advance(previous, connection);
      }
    });
    logger.info(
      `[MINT_LOG_REBUILT] [entries ${count}] [cards with minted counts ${bases.size}]`
    );
    return { entries: count, cards: bases.size, head: previous };
  }

  private assertChain(
    entry: MintLogEntryBody,
    previous: { seq: number; hash: string } | null
  ): void {
    const expectedSeq = previous ? previous.seq + 1 : 0;
    if (entry.seq !== expectedSeq || entry.prev !== (previous?.hash ?? null)) {
      throw new Error(
        `Mint log gap: entry ${entry.seq} (prev ${entry.prev}) after ${previous?.seq ?? 'nothing'}`
      );
    }
  }

  private async applyGenesis(
    entry: MintLogEntryBody,
    bases: Map<string, { card: MintCardRef; base: MintedBase }>,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const cards = (entry.inputs.cards ?? []) as MintGenesisCard[];
    const block = Number(entry.inputs.distribution_cursor_block ?? 0);
    for (const listed of cards) {
      const file = decodeGenesisFile(
        await this.content.get(listed.cid),
        listed
      );
      const card = mintCard(file.card.contract, file.card.card_id);
      const current = await this.reader.capture(card, connection);
      await this.writer.apply(
        card,
        diffCardState(current, file.state),
        connection
      );
      await this.writer.applyRows(
        PINNED_SPEC,
        card,
        { upsert: file.normalized_pinned, delete: [] },
        connection
      );
      if (file.normalized_pinned.length) {
        bases.set(cardKey(card), { card, base: { block, pinned: true } });
      }
    }
  }

  private async deriveMinted(
    card: MintCardRef,
    base: MintedBase,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const keep = base.pinned ? 'dn.minted' : '0';
    await this.db().execute(
      `update ${DISTRIBUTION_NORMALIZED_TABLE} dn
       left join (
         select lower(to_address) as wallet, sum(token_count) as minted
         from ${TRANSACTIONS_TABLE}
         where lower(contract) = :contract and token_id = :card_id
           and from_address in (:manifold, :null_address)
           and value > 0 and block > :block
         group by lower(to_address)
       ) mints on mints.wallet = lower(dn.wallet)
       set dn.minted = ${keep} + coalesce(mints.minted, 0)
       where dn.contract = :contract and dn.card_id = :card_id`,
      {
        contract: card.contract,
        card_id: card.card_id,
        manifold: MANIFOLD,
        null_address: NULL_ADDRESS,
        block: base.block
      },
      { wrappedConnection: connection }
    );
    // A separate statement: a multi-table UPDATE does not promise the order
    // of its assignments, so total_count must not share one with minted.
    await this.db().execute(
      `update ${DISTRIBUTION_NORMALIZED_TABLE}
       set total_count = minted + airdrops
       where contract = :contract and card_id = :card_id`,
      { contract: card.contract, card_id: card.card_id },
      { wrappedConnection: connection }
    );
  }

  private async deriveCardInfo(
    card: MintCardRef,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const nfts =
      card.contract === MEMELAB_CONTRACT.toLowerCase()
        ? NFTS_MEME_LAB_TABLE
        : NFTS_TABLE;
    await this.db().execute(
      `update ${DISTRIBUTION_NORMALIZED_TABLE} dn
       join ${nfts} n on n.id = dn.card_id and lower(n.contract) = dn.contract
       set dn.card_name = n.name, dn.mint_date = n.mint_date
       where dn.contract = :contract and dn.card_id = :card_id
         and (dn.card_name is null or dn.card_name = '' or dn.mint_date is null)`,
      { contract: card.contract, card_id: card.card_id },
      { wrappedConnection: connection }
    );
  }
}
