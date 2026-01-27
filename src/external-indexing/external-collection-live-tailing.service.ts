import { Logger } from '../logging';
import { env } from '../env';
import { ethers } from 'ethers';
import { RequestContext } from '../request.context';
import { Time, Timer } from '../time';
import {
  externalIndexingRepository,
  ExternalIndexingRepository
} from './external-indexing.repository';
import { ExternalIndexedOwnership721Entity } from '../entities/IExternalIndexedOwnership721';
import { ExternalIndexedOwnership721HistoryEntity } from '../entities/IExternalIndexedOwnership721History';
import { ExternalIndexedTransfersEntity } from '../entities/IExternalIndexedTransfer';
import { externalIndexerRpc, ExternalIndexerRpc } from './external-indexer-rpc';
import {
  externalCollectionSaleDetector,
  ExternalCollectionSaleDetector
} from './external-collection-sale-detector';

const PUNKS_ABI_EVENTS = [
  'event PunkTransfer(address indexed from, address indexed to, uint256 punkIndex)',
  'event Assign(address indexed to, uint256 punkIndex)'
];

const PUNKS_TRANSFER_TOPIC = ethers.id('PunkTransfer(address,address,uint256)');
const PUNKS_ASSIGN_TOPIC = ethers.id('Assign(address,uint256)');
const ERC721_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const IFACE_ERC721 = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
]);

const CRYPTOPUNKS_MAINNET = '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb';

export class ExternalCollectionLiveTailService {
  private readonly log = Logger.get(this.constructor.name);

  constructor(
    private readonly indexingRepo: ExternalIndexingRepository,
    private readonly rpc: ExternalIndexerRpc,
    private readonly saleDetector: ExternalCollectionSaleDetector
  ) {}

  private async getBestBlock(): Promise<number> {
    let tries = 0;
    while (true) {
      try {
        return await this.rpc.provider.getBlockNumber();
      } catch (e) {
        if (++tries > 3) throw e;
        await Time.millis(500 * tries).sleep();
      }
    }
  }

  private async getBlockTimestamp(blockNumber: number): Promise<number> {
    const blk = await this.rpc.provider.getBlock(blockNumber);
    if (!blk) throw new Error(`Block ${blockNumber} not found`);
    return blk.timestamp;
  }

  private async getLogs(contract: string, fromBlock: number, toBlock: number) {
    if (contract.toLowerCase() === CRYPTOPUNKS_MAINNET) {
      return this.rpc.provider.getLogs({
        address: contract,
        topics: [[PUNKS_TRANSFER_TOPIC, PUNKS_ASSIGN_TOPIC]],
        fromBlock,
        toBlock
      });
    }
    return this.rpc.provider.getLogs({
      address: contract,
      topics: [ERC721_TRANSFER_TOPIC],
      fromBlock,
      toBlock
    });
  }

  private async normalizeTransferLogs(contract: string, logs: ethers.Log[]) {
    if (contract.toLowerCase() !== CRYPTOPUNKS_MAINNET) {
      const erc721Logs = logs.filter(
        (l) => l.topics?.length === 4 && (l.data === '0x' || l.data === '0x0')
      );

      const blocks = Array.from(new Set(erc721Logs.map((l) => l.blockNumber)));
      const ts = new Map<number, number>();
      for (const b of blocks) ts.set(b, await this.getBlockTimestamp(b));

      return erc721Logs
        .map((l) => {
          const dec = IFACE_ERC721.parseLog(l);
          if (!dec) return null;
          return {
            blockNumber: l.blockNumber,
            logIndex: l.index,
            tx: l.transactionHash,
            tokenId: dec.args.tokenId.toString(),
            from: (dec.args.from as string).toLowerCase(),
            to: (dec.args.to as string).toLowerCase(),
            timestampMs: Time.seconds(ts.get(l.blockNumber)!).toMillis()
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort(
          (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex
        );
    }

    const ifacePunks = new ethers.Interface(PUNKS_ABI_EVENTS);

    const blocks = Array.from(new Set(logs.map((l) => l.blockNumber)));
    const ts = new Map<number, number>();
    for (const b of blocks) ts.set(b, await this.getBlockTimestamp(b));

    const out = [];
    for (const l of logs) {
      let dec;
      try {
        dec = ifacePunks.parseLog(l);
      } catch {
        continue;
      }
      if (!dec) continue;

      if (dec.name === 'PunkTransfer') {
        const from = (dec.args.from as string).toLowerCase();
        const to = (dec.args.to as string).toLowerCase();
        const tokenId = dec.args.punkIndex.toString();
        out.push({
          blockNumber: l.blockNumber,
          logIndex: l.index,
          tx: l.transactionHash,
          tokenId,
          from,
          to,
          timestampMs: Time.seconds(ts.get(l.blockNumber)!).toMillis()
        });
      } else if (dec.name === 'Assign') {
        const to = (dec.args.to as string).toLowerCase();
        const tokenId = dec.args.punkIndex.toString();
        out.push({
          blockNumber: l.blockNumber,
          logIndex: l.index,
          tx: l.transactionHash,
          tokenId,
          from: ethers.ZeroAddress,
          to,
          timestampMs: Time.seconds(ts.get(l.blockNumber)!).toMillis()
        });
      }
    }

    return out.sort(
      (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex
    );
  }

  public async processLiveRange(
    collection: { partition: string; chain: number; contract: string },
    fromBlock: number,
    toBlock: number,
    ctx: RequestContext
  ): Promise<{ events: number; lastBlockProcessed: number }> {
    const { partition, chain, contract } = collection;
    const clog = Logger.get(
      `${this.log.name} ${JSON.stringify({ chain, contract })}`
    );

    let rawLogs: ethers.Log[] = [];
    try {
      rawLogs = await this.getLogs(contract, fromBlock, toBlock);
    } catch (e) {
      clog.error('getLogs failed', { error: String(e), fromBlock, toBlock });
      return { events: 0, lastBlockProcessed: fromBlock - 1 };
    }
    if (rawLogs.length === 0) {
      clog.info('No events in live range', { fromBlock, toBlock });
      return { events: 0, lastBlockProcessed: toBlock };
    }

    const events = await this.normalizeTransferLogs(contract, rawLogs);
    const now = Time.currentMillis();

    // ✅ Per-tx memo so we call the detector at most once per transaction
    const saleByTx = new Map<string, Promise<boolean>>();

    const getIsSale = (txHash: string) => {
      const existing = saleByTx.get(txHash);
      if (existing) return existing;
      const p = this.saleDetector
        .isSale({ txHash, contract })
        .catch(() => false); // defensive: on RPC hiccups, treat as non-sale
      saleByTx.set(txHash, p);
      return p;
    };

    const transfers: ExternalIndexedTransfersEntity[] = [];
    const historyRows: ExternalIndexedOwnership721HistoryEntity[] = [];
    const currentByToken = new Map<string, ExternalIndexedOwnership721Entity>();

    for (const ev of events) {
      // Never classify mints as sales
      const isMint = ev.from === ethers.ZeroAddress;

      const isSale = isMint ? false : await getIsSale(ev.tx);

      transfers.push({
        partition,
        block_number: ev.blockNumber,
        log_index: ev.logIndex,
        chain,
        contract,
        token_id: Number(ev.tokenId),
        from: ev.from,
        to: ev.to,
        amount: 1,
        is_monetary_sale: isSale ? 1 : 0,
        tx_hash: ev.tx,
        time: ev.timestampMs,
        sale_epoch_start: isSale ? 1 : 0,
        created_at: now,
        updated_at: now
      });

      historyRows.push({
        partition,
        token_id: ev.tokenId,
        block_number: ev.blockNumber,
        log_index: ev.logIndex,
        owner: ev.to,
        since_block: ev.blockNumber,
        since_time: ev.timestampMs,
        acquired_as_sale: isSale ? 1 : 0,
        sale_epoch_start_block: isSale ? ev.blockNumber : null,
        sale_epoch_tx: isSale ? ev.tx : null,
        created_at: now,
        updated_at: now
      });

      const prev = currentByToken.get(ev.tokenId);
      currentByToken.set(ev.tokenId, {
        partition,
        token_id: ev.tokenId,
        owner: ev.to,
        since_block: ev.blockNumber,
        since_time: ev.timestampMs,
        sale_epoch_start_block: isSale
          ? ev.blockNumber
          : (prev?.sale_epoch_start_block ?? ev.blockNumber),
        sale_epoch_tx: isSale ? ev.tx : (prev?.sale_epoch_tx ?? null),
        free_transfers_since_epoch: isSale
          ? 0
          : (prev?.free_transfers_since_epoch ?? 0) + 1,
        created_at: prev?.created_at ?? now,
        updated_at: now
      });
    }

    await this.indexingRepo.upsertTransfers(transfers, ctx);
    await this.indexingRepo.upsertOwnersHistory(historyRows, ctx);
    await this.indexingRepo.upsertOwners(
      Array.from(currentByToken.values()),
      ctx
    );

    clog.info('Processed live events', {
      eventCount: events.length,
      tokensUpdated: currentByToken.size
    });

    return { events: events.length, lastBlockProcessed: toBlock };
  }

  public async liveTailCycle() {
    const timer = new Timer(`${this.constructor.name}`);
    const ctx: RequestContext = { timer };
    this.log.info('Starting live tail cycle...');

    try {
      const collections = await this.indexingRepo.findLiveTailingCollections(
        100,
        ctx
      );
      if (collections.length === 0) {
        this.log.info('No collections in LIVE_TAILING state');
        return;
      }

      const best = await this.getBestBlock();
      const reorgDepth = env.getIntOrThrow('NFT_INDEXER_REORG_DEPTH_BLOCKS');
      const safeTarget = best - reorgDepth;
      const range = env.getIntOrNull('NFT_INDEXER_LIVE_TAIL_RANGE') ?? 2000;

      for (const c of collections) {
        const {
          partition,
          chain,
          contract,
          safe_head_block,
          last_indexed_block
        } = c;
        const fromBlock = Math.max(safe_head_block, last_indexed_block) + 1;
        const toBlock = Math.min(fromBlock + range - 1, safeTarget);

        const perLog = Logger.get(
          `${this.log.name} ${JSON.stringify({ chain, contract })}`
        );

        if (fromBlock > safeTarget || fromBlock > toBlock) {
          const safeTs =
            safeTarget > 0
              ? await this.getBlockTimestamp(safeTarget)
              : undefined;
          const nowSec = Time.now().toSeconds();
          const lagBlocks = Math.max(
            0,
            safeTarget - Math.max(safe_head_block, last_indexed_block)
          );
          const lagSeconds = safeTs ? Math.max(0, nowSec - safeTs) : 0;
          await this.indexingRepo.refreshLagMetrics(
            { partition, lag_blocks: lagBlocks, lag_seconds: lagSeconds },
            ctx
          );
          continue;
        }

        try {
          const { lastBlockProcessed } = await this.processLiveRange(
            { partition, chain, contract },
            fromBlock,
            toBlock,
            ctx
          );

          const safeTs =
            safeTarget > 0
              ? await this.getBlockTimestamp(safeTarget)
              : undefined;
          const nowSec = Time.now().toSeconds();
          const lagBlocks = Math.max(0, safeTarget - lastBlockProcessed);
          const lagSeconds = safeTs ? Math.max(0, nowSec - safeTs) : 0;

          const ok = await this.indexingRepo.advanceHeadsIfNotSnapshotting(
            {
              partition,
              to_block: lastBlockProcessed,
              lag_blocks: lagBlocks,
              lag_seconds: lagSeconds
            },
            ctx
          );

          if (!ok)
            perLog.warn('Skipped advancing: snapshotting detected mid-cycle');
        } catch (e: any) {
          perLog.error('Failed to process collection', { error: String(e) });
        }
      }

      this.log.info(
        `Live tail cycle complete: processed ${collections.length} collections`
      );
    } finally {
      this.log.info(`[liveTailCycle timing report ${ctx.timer?.getReport()}]`);
    }
  }
}

export const externalCollectionLiveTailService =
  new ExternalCollectionLiveTailService(
    externalIndexingRepository,
    externalIndexerRpc,
    externalCollectionSaleDetector
  );
