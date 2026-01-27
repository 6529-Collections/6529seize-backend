import { Logger } from '../logging';
import { env } from '../env';
import { Contract, ethers } from 'ethers';
import { Time, Timer } from '../time';
import { IndexedContractStandard } from '../entities/IExternalIndexedContract';
import { numbers } from '../numbers';
import { ExternalIndexedOwnership721HistoryEntity } from '../entities/IExternalIndexedOwnership721History';
import {
  externalIndexingRepository,
  ExternalIndexingRepository
} from './external-indexing.repository';
import { RequestContext } from '../request.context';
import { ExternalIndexedOwnership721Entity } from '../entities/IExternalIndexedOwnership721';
import { randomUUID } from 'crypto';
import { ExternalIndexerRpc, externalIndexerRpc } from './external-indexer-rpc';

const CRYPTOPUNKS_MAINNET = '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb';
const ERC721_ABI = [
  'function ownerOf(uint256) view returns (address)',
  'function name() view returns (string)'
];
const ERC165_ABI = [
  'function supportsInterface(bytes4 interfaceId) view returns (bool)'
];
const IFACE_ERC721_ENUM = '0x780e9d63';
const ERC721_ENUM_ABI = [
  'function totalSupply() view returns (uint256)',
  'function tokenByIndex(uint256 index) view returns (uint256)'
];

const MULTICALL3_ABI = [
  'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)'
];
const PUNKS_ABI = [
  'function punkIndexToAddress(uint256) view returns (address)',
  'function allPunksAssigned() view returns (bool)',
  'function punksRemainingToAssign() view returns (uint256)'
];

export interface SnapshotCollectionJob {
  type: 'SnapshotCollection';
  chain: number;
  contract: string;
  lockOwner: string;
  atBlock?: number | null;
}

export class ExternalCollectionSnapshottingService {
  private readonly logger = Logger.get(
    ExternalCollectionSnapshottingService.name
  );
  constructor(
    private readonly externalIndexingRepository: ExternalIndexingRepository,
    private readonly rpc: ExternalIndexerRpc
  ) {}

  public async snapshot(job: SnapshotCollectionJob): Promise<void> {
    const { chain, contract } = job;
    const contractLc = contract.toLowerCase();
    const partition = `${chain}:${contractLc}`;
    const jobKey = `${this.logger.name} ${JSON.stringify({ chain, contract: contractLc, lockOwner: job.lockOwner })}`;
    const log = Logger.get(jobKey);
    const ctx: RequestContext = { timer: new Timer(jobKey) };

    const best = await this.getBestBlock();
    const reorgDepth = env.getIntOrThrow('NFT_INDEXER_REORG_DEPTH_BLOCKS');
    const safeHead = best - reorgDepth;
    const atBlock = job.atBlock ?? safeHead;

    log.info('Starting snapshot', { best, safe: safeHead, atBlock });

    const validation = await this.validateIndexable(contractLc, atBlock);
    if (!validation.ok) {
      const reason = validation.reason ?? 'Contract is not indexable';
      await this.externalIndexingRepository.markUnindexableWithMessage(
        {
          partition,
          last_event_time: Time.currentMillis(),
          error_message: reason
        },
        ctx
      );
      log.warn('Marked UNINDEXABLE before snapshot', { partition, reason });
      return;
    }

    let standard = validation.standard ?? IndexedContractStandard.ERC721;
    let adapterName: string | null = validation.adapter ?? null;
    let ids: bigint[] = [];
    let totalSupply: number | null = null;
    let collectionName: string | null = null;
    let tokenByIndexZero: bigint | null = null;
    let succeeded = false;

    try {
      if (contractLc === CRYPTOPUNKS_MAINNET) {
        standard = IndexedContractStandard.LEGACY_721;
        adapterName = 'cryptopunks';
        collectionName = 'CryptoPunks';
        ids = this.enumerateCryptoPunksIds();
        totalSupply = env.getIntOrNull('PUNKS_SUPPLY') ?? 10000;
        log.info('CryptoPunks adapter engaged', { count: ids.length });
      } else {
        const erc721 = new Contract(contract, ERC721_ABI, this.rpc.provider);
        if (standard === IndexedContractStandard.ERC721) {
          collectionName = await this.tryGetName(erc721, atBlock, log);
        }
        const supportsEnum = await this.supportsEnumerable(contract, atBlock);

        if (supportsEnum) {
          const ts = await this.tryGetTotalSupply(contract, atBlock);
          if (ts) totalSupply = numbers.parseIntOrNull(ts.toString());
          tokenByIndexZero = await this.tryGetTokenByIndexZero(
            contract,
            atBlock
          );
        }

        const fast = await this.enumerateContiguousFast(
          erc721,
          contract,
          atBlock,
          tokenByIndexZero,
          log
        );
        if (fast) {
          ids = fast.ids;
          totalSupply = fast.totalSupply;
        } else {
          if (totalSupply == null) {
            const ts = await this.tryGetTotalSupply(contract, atBlock);
            if (ts) totalSupply = numbers.parseIntOrNull(ts.toString());
          }

          const maxIds = env.getIntOrNull('SNAPSHOT_MAX_IDS') ?? 250_000;
          if (totalSupply && totalSupply > maxIds) {
            const msg = `Given collections totalSupply of ${totalSupply} is too big so unfortunately it can't be indexed automatically.`;
            log.warn('Enumerable supply too large; aborting snapshot', {
              totalSupply,
              maxIds
            });
            throw new Error(msg);
          }

          if (supportsEnum && totalSupply && totalSupply > 0) {
            try {
              ids = await this.enumerateByTokenByIndexMulticall(
                contract,
                totalSupply,
                atBlock,
                log
              );
            } catch (e) {
              log.warn(
                'Enumerable (multicall) failed; falling back to ownerOf()',
                { error: String(e) }
              );
              ids = await this.enumerateByOwnerOf(
                erc721,
                atBlock,
                tokenByIndexZero,
                log
              );
            }
          } else {
            ids = await this.enumerateByOwnerOf(
              erc721,
              atBlock,
              tokenByIndexZero,
              log
            );
          }
        }
      }

      if (totalSupply == null) totalSupply = ids.length;
      log.info('Enumerated token ids', { count: ids.length });

      const tsSec = await this.getBlockTimestamp(atBlock);
      const sinceTimeMs = Time.seconds(tsSec).toMillis();

      const owners =
        contractLc === CRYPTOPUNKS_MAINNET
          ? await this.ownersViaMulticallPunks(contract, ids, atBlock, log)
          : await this.ownersViaMulticall721(contract, ids, atBlock, log);

      const now = Time.currentMillis();
      const currentRows = owners
        .map<ExternalIndexedOwnership721Entity | null>((owner, i) =>
          owner === null
            ? null
            : {
                partition,
                token_id: `${ids[i].toString()}`,
                owner,
                since_block: atBlock,
                since_time: sinceTimeMs,
                sale_epoch_start_block: atBlock,
                sale_epoch_tx: null,
                free_transfers_since_epoch: 0,
                created_at: now,
                updated_at: now
              }
        )
        .filter((it) => !!it) as ExternalIndexedOwnership721Entity[];

      await this.externalIndexingRepository.upsertOwners(currentRows, ctx);
      log.info('Snapshot: current state upserted', {
        count: currentRows.length
      });

      const historyRows = owners
        .map<ExternalIndexedOwnership721HistoryEntity | null>((owner, i) =>
          owner === null
            ? null
            : {
                partition,
                token_id: ids[i].toString(),
                block_number: atBlock,
                log_index: 0,
                owner,
                since_block: atBlock,
                since_time: sinceTimeMs,
                acquired_as_sale: 1,
                sale_epoch_start_block: atBlock,
                sale_epoch_tx: null,
                created_at: now,
                updated_at: now
              }
        )
        .filter((it): it is ExternalIndexedOwnership721HistoryEntity => !!it);

      await this.externalIndexingRepository.upsertOwnersHistory(
        historyRows,
        ctx
      );
      log.info('Snapshot: history baseline upserted', {
        count: historyRows.length
      });

      const tsDiffFromNowSec = Time.now().minusSeconds(tsSec).toSeconds();
      const lagSeconds = Math.max(0, tsDiffFromNowSec);

      const committed =
        await this.externalIndexingRepository.commitSnapshotSuccess(
          {
            partition,
            at_block: Number(atBlock),
            lock_owner: job.lockOwner,
            last_event_time: Time.currentMillis(),
            standard:
              standard === IndexedContractStandard.LEGACY_721
                ? IndexedContractStandard.LEGACY_721
                : IndexedContractStandard.ERC721,
            adapter: adapterName,
            total_supply: totalSupply,
            lag_blocks: 0,
            lag_seconds: lagSeconds,
            collection_name: collectionName
          },
          ctx
        );

      if (!committed) {
        throw new Error('Commit conditions failed (status/lock mismatch)');
      }

      await this.externalIndexingRepository.setIndexedSinceIfEmpty(
        { partition, at_block: Number(atBlock) },
        ctx
      );

      succeeded = true;
      log.info('Snapshot complete', { partition, atBlock });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      log.error('Snapshot job failed', { name: e?.name, message: msg });

      await this.externalIndexingRepository.failSnapshotAndUnlockWithMessage(
        {
          partition,
          lock_owner: job.lockOwner,
          last_event_time: Time.currentMillis(),
          error_message: msg
        },
        ctx
      );
      throw e;
    } finally {
      if (!succeeded) {
        log.warn('Snapshot ended without success', {
          partition,
          atBlock
        });
      }
    }
  }

  private async enumerateByOwnerOf(
    erc721: Contract,
    atBlock: number,
    startHint: bigint | null,
    log: Logger
  ): Promise<bigint[]> {
    const maxIds = env.getIntOrNull('SNAPSHOT_MAX_IDS') ?? 250_000;
    const stopAfterEmpty = env.getIntOrNull('SNAPSHOT_STOP_AFTER_EMPTY') ?? 500;
    const probeBatch = Math.max(
      1,
      env.getIntOrNull('SNAPSHOT_OWNEROF_PROBE_BATCH') ?? 64
    );

    const start = await this.pickStartId(erc721, atBlock, startHint, log);
    const ids: bigint[] = [];
    let probe = start;
    let emptyStreak = 0;

    log.info('Starting ownerOf() probing', {
      start: start.toString(),
      stopAfterEmpty,
      maxIds
    });

    while (emptyStreak < stopAfterEmpty && ids.length < maxIds) {
      const remainingIds = maxIds - ids.length;
      const remainingUntilEmpty = stopAfterEmpty - emptyStreak;
      const chunkSize = Math.max(
        1,
        Math.min(probeBatch, remainingIds, remainingUntilEmpty)
      );
      const chunkIds: bigint[] = new Array(chunkSize);
      for (let i = 0; i < chunkSize; i++) {
        chunkIds[i] = probe + BigInt(i);
      }

      const owners = await this.ownerOfProbeBatch(
        erc721,
        chunkIds,
        atBlock,
        log
      );

      let advanced = 0;
      for (let i = 0; i < owners.length; i++) {
        const tokenId = chunkIds[i];
        const owner = owners[i];
        advanced++;

        if (owner) {
          ids.push(tokenId);
          emptyStreak = 0;
          if (ids.length % 250 === 0) {
            log.info('ownerOf() probe progress', {
              found: ids.length,
              lastId: tokenId.toString()
            });
          }
          if (ids.length >= maxIds) {
            break;
          }
        } else {
          emptyStreak++;
          if (emptyStreak >= stopAfterEmpty) {
            break;
          }
        }
      }

      probe += BigInt(advanced);

      if (emptyStreak >= stopAfterEmpty || ids.length >= maxIds) {
        break;
      }
    }

    log.info('ownerOf() probing finished', {
      found: ids.length,
      lastProbed: (probe - BigInt(1)).toString()
    });
    return ids;
  }

  private async ownerOfProbeBatch(
    erc721: Contract,
    tokenIds: bigint[],
    atBlock: number,
    log: Logger
  ): Promise<(string | null)[]> {
    if (tokenIds.length === 0) {
      return [];
    }

    const mc = new Contract(
      this.multicallAddr(),
      MULTICALL3_ABI,
      this.rpc.provider
    );
    const erc721Iface = new ethers.Interface(ERC721_ABI);

    const calls = tokenIds.map((tid) => ({
      target: erc721.address,
      callData: erc721Iface.encodeFunctionData('ownerOf', [tid])
    }));

    try {
      const ret: { success: boolean; returnData: string }[] =
        await mc.tryAggregate(false, calls, {
          blockTag: atBlock
        });

      return ret.map((r, idx) => {
        if (!r?.success || !r.returnData || r.returnData === '0x') {
          return null;
        }
        try {
          const decoded: ethers.Result = erc721Iface.decodeFunctionResult(
            'ownerOf',
            r.returnData
          );
          const owner = (decoded[0] as string) ?? null;
          return owner && owner !== ethers.ZeroAddress ? owner : null;
        } catch {
          return null;
        }
      });
    } catch (e) {
      log.warn(
        'ownerOf() probe multicall failed; falling back to single calls',
        {
          error: String(e),
          chunk: tokenIds.length
        }
      );
    }

    const owners: (string | null)[] = new Array(tokenIds.length);
    for (let i = 0; i < tokenIds.length; i++) {
      owners[i] = await this.ownerOfExists(erc721, tokenIds[i], atBlock);
    }
    return owners;
  }

  private async getBestBlock(): Promise<number> {
    let tries = 0;
    while (true) {
      try {
        return await this.rpc.provider.getBlockNumber();
      } catch (e) {
        if (++tries > 3) throw e;
        await new Promise((r) => setTimeout(r, 500 * tries));
      }
    }
  }

  private enumerateCryptoPunksIds(): bigint[] {
    const total = BigInt(env.getIntOrNull('PUNKS_SUPPLY') ?? 10000);
    const ids = new Array(Number(total));
    for (let i = 0; i < ids.length; i++) ids[i] = BigInt(i);
    return ids as unknown as bigint[];
  }

  private async supportsEnumerable(
    contractAddr: string,
    atBlock: number
  ): Promise<boolean> {
    const erc165 = new Contract(contractAddr, ERC165_ABI, this.rpc.provider);
    try {
      return !!(await erc165.supportsInterface(IFACE_ERC721_ENUM, {
        blockTag: atBlock
      }));
    } catch {
      return false;
    }
  }

  private async tryGetName(
    erc721: Contract,
    atBlock: number,
    log: Logger
  ): Promise<string | null> {
    try {
      const name: string = await erc721.name({ blockTag: atBlock });
      if (typeof name !== 'string') return null;

      const trimmed = name.trim();
      const limited = trimmed.slice(0, 255);
      if (trimmed.length > limited.length) {
        log.warn('Truncated collection name from name()', {
          originalLength: trimmed.length
        });
      }
      return limited;
    } catch (e) {
      log.warn('name() call failed', { error: String(e) });
      return null;
    }
  }

  private async tryGetTotalSupply(
    contractAddr: string,
    atBlock: number
  ): Promise<bigint | null> {
    const erc721Enum = new Contract(
      contractAddr,
      ERC721_ENUM_ABI,
      this.rpc.provider
    );
    try {
      const ts = await erc721Enum.totalSupply({ blockTag: atBlock });
      return BigInt(ts.toString());
    } catch {
      return null;
    }
  }

  private async enumerateContiguousFast(
    erc721: Contract,
    contractAddr: string,
    atBlock: number,
    startHint: bigint | null,
    log: Logger
  ): Promise<{ ids: bigint[]; totalSupply: number } | null> {
    const ts = await this.tryGetTotalSupply(contractAddr, atBlock);
    if (!ts || ts <= BigInt(0)) return null;

    const maxIds = BigInt(env.getIntOrNull('SNAPSHOT_MAX_IDS') ?? 250_000);
    if (ts > maxIds) {
      log.warn('Skipping fast contiguous enumeration: supply too large', {
        totalSupply: ts.toString()
      });
      return null;
    }

    const start = await this.pickStartId(erc721, atBlock, startHint, log);
    const ids = Array.from({ length: Number(ts) }, (_, i) => start + BigInt(i));

    log.info('Trying FAST contiguous enumeration', {
      start: start.toString(),
      totalSupply: ts.toString()
    });

    const ok = await this.sampleOwnerOf(erc721, ids, atBlock);
    if (!ok) {
      log.info('FAST contiguous check failed; falling back');
      return null;
    }

    log.info('FAST contiguous enumeration accepted', { count: ids.length });
    return { ids, totalSupply: Number(ts) };
  }

  private async ownerOfExists(
    erc721: Contract,
    tokenId: bigint,
    atBlock: number
  ): Promise<string | null> {
    try {
      return await erc721.ownerOf(tokenId, { blockTag: atBlock });
    } catch {
      return null;
    }
  }

  private async tryGetTokenByIndexZero(
    contractAddr: string,
    atBlock: number
  ): Promise<bigint | null> {
    const erc721Enum = new Contract(
      contractAddr,
      ERC721_ENUM_ABI,
      this.rpc.provider
    );
    try {
      const tid = await erc721Enum.tokenByIndex(BigInt(0), {
        blockTag: atBlock
      });
      return BigInt(tid.toString());
    } catch {
      return null;
    }
  }

  private async pickStartId(
    erc721: Contract,
    atBlock: number,
    startHint: bigint | null,
    log: Logger
  ): Promise<bigint> {
    if (startHint != null) {
      const start = BigInt(startHint.toString());
      log.info('Using start hint from tokenByIndex(0)', {
        start: start.toString()
      });
      return start;
    }
    return (await this.ownerOfExists(erc721, BigInt(0), atBlock))
      ? BigInt(0)
      : BigInt(1);
  }

  private async sampleOwnerOf(
    erc721: Contract,
    ids: bigint[],
    atBlock: number,
    maxSamples = 24
  ): Promise<boolean> {
    if (ids.length === 0) return true;

    const samples: bigint[] = [];
    const push = (v: bigint) => {
      if (samples.length < maxSamples) samples.push(v);
    };

    push(ids[0]);
    push(ids[ids.length - 1]);
    push(ids[Math.floor(ids.length / 2)]);
    for (let i = 0; i < maxSamples && i < ids.length; i++) {
      const idx = Math.floor((i / maxSamples) * (ids.length - 1));
      push(ids[idx]);
    }

    for (const tid of samples) {
      const owner = await this.ownerOfExists(erc721, tid, atBlock);
      if (!owner) return false;
    }
    return true;
  }

  private multicallAddr(): string {
    return (
      env.getStringOrNull('MULTICALL3_ADDRESS') ??
      '0xcA11bde05977b3631167028862bE2a173976CA11'
    );
  }
  private async enumerateByTokenByIndexMulticall(
    contractAddr: string,
    totalSupply: number,
    atBlock: number,
    log: Logger
  ): Promise<bigint[]> {
    const mc = new Contract(
      this.multicallAddr(),
      MULTICALL3_ABI,
      this.rpc.provider
    );
    const erc721EnumIface = new ethers.Interface(ERC721_ENUM_ABI);

    const batchSize = env.getIntOrNull('SNAPSHOT_MULTICALL_BATCH') ?? 300;
    const ids: bigint[] = new Array(totalSupply);
    let filled = 0;

    for (let start = 0; start < totalSupply; start += batchSize) {
      const end = Math.min(start + batchSize, totalSupply);
      const calls = [];
      for (let i = start; i < end; i++) {
        calls.push({
          target: contractAddr,
          callData: erc721EnumIface.encodeFunctionData('tokenByIndex', [
            BigInt(i)
          ])
        });
      }

      let ret: { success: boolean; returnData: string }[];
      try {
        ret = await mc.tryAggregate(false, calls, {
          blockTag: atBlock
        });
      } catch (e) {
        log.warn(
          'Multicall tokenByIndex batch failed; falling back to single calls for this chunk',
          {
            error: String(e),
            start,
            end,
            batchSize
          }
        );
        const erc721Enum = new Contract(
          contractAddr,
          ERC721_ENUM_ABI,
          this.rpc.provider
        );
        for (let i = start; i < end; i++) {
          try {
            ids[i] = await erc721Enum.tokenByIndex(BigInt(i), {
              blockTag: atBlock
            });
            filled++;
          } catch {
            // should not happen for i < totalSupply, but tolerate
          }
        }
        continue;
      }

      for (let j = 0; j < ret.length; j++) {
        const r = ret[j];
        const globalIdx = start + j;
        if (!r?.success || !r.returnData || r.returnData === '0x') continue;
        try {
          const decoded = erc721EnumIface.decodeFunctionResult(
            'tokenByIndex',
            r.returnData
          );

          ids[globalIdx] = decoded[0] as bigint;
          filled++;
        } catch {
          // ignore bad decode; leave hole (rare)
        }
      }

      if (end % Math.max(1000, batchSize * 10) === 0) {
        log.info('tokenByIndex multicall progress', { filled, totalSupply });
      }
    }

    const out = ids.filter((v) => typeof v === 'bigint');
    if (out.length !== totalSupply) {
      log.warn('tokenByIndex returned fewer ids than totalSupply', {
        expected: totalSupply,
        got: out.length
      });
    }
    return out;
  }

  private async getBlockTimestamp(blockNumber: number): Promise<number> {
    const blk = await this.rpc.provider.getBlock(blockNumber);
    if (!blk) throw new Error(`Block ${blockNumber} not found`);
    return blk.timestamp;
  }

  private async ownersViaMulticallPunks(
    contractAddr: string,
    tokenIds: bigint[],
    atBlock: number,
    log: Logger
  ): Promise<(string | null)[]> {
    const mc = new Contract(
      this.multicallAddr(),
      MULTICALL3_ABI,
      this.rpc.provider
    );
    const punksIface = new ethers.Interface(PUNKS_ABI);

    const batchSize = env.getIntOrNull('SNAPSHOT_MULTICALL_BATCH') ?? 150;
    const results: (string | null)[] = new Array(tokenIds.length).fill(null);

    for (let i = 0; i < tokenIds.length; i += batchSize) {
      const slice = tokenIds.slice(i, i + batchSize);
      const calls = slice.map((tid) => ({
        target: contractAddr,
        callData: punksIface.encodeFunctionData('punkIndexToAddress', [tid])
      }));

      let ret: { success: boolean; returnData: string }[];
      try {
        ret = await mc.tryAggregate(false, calls, {
          blockTag: atBlock
        });
      } catch (e) {
        log.warn(
          'Multicall (punks) failed; fallback to single calls for this chunk',
          { error: String(e) }
        );
        const c = new Contract(contractAddr, PUNKS_ABI, this.rpc.provider);
        for (let j = 0; j < slice.length; j++) {
          try {
            const owner = await c.punkIndexToAddress(slice[j], {
              blockTag: atBlock
            });
            results[i + j] =
              owner && owner !== ethers.ZeroAddress
                ? owner.toLowerCase()
                : null;
          } catch {
            results[i + j] = null;
          }
        }
        continue;
      }

      for (let j = 0; j < ret.length; j++) {
        const r = ret[j];
        if (!r?.success || !r.returnData || r.returnData === '0x') {
          results[i + j] = null;
          continue;
        }
        try {
          const decoded: ethers.Result = punksIface.decodeFunctionResult(
            'punkIndexToAddress',
            r.returnData
          );
          const owner = (decoded[0] as string) ?? null;
          results[i + j] =
            owner && owner !== ethers.ZeroAddress ? owner.toLowerCase() : null;
        } catch {
          results[i + j] = null;
        }
      }
    }

    return results;
  }

  private async ownersViaMulticall721(
    contractAddr: string,
    tokenIds: bigint[],
    atBlock: number,
    log: Logger
  ): Promise<(string | null)[]> {
    const mc = new Contract(
      this.multicallAddr(),
      MULTICALL3_ABI,
      this.rpc.provider
    );
    const erc721Iface = new ethers.Interface(ERC721_ABI);
    const c = new Contract(contractAddr, ERC721_ABI, this.rpc.provider);

    const batchSize = env.getIntOrNull('SNAPSHOT_MULTICALL_BATCH') ?? 150;
    const results: (string | null)[] = new Array(tokenIds.length).fill(null);

    for (let i = 0; i < tokenIds.length; i += batchSize) {
      const slice = tokenIds.slice(i, i + batchSize);
      const calls = slice.map((tid) => ({
        target: contractAddr,
        callData: erc721Iface.encodeFunctionData('ownerOf', [tid])
      }));

      let ret: { success: boolean; returnData: string }[];
      try {
        ret = await mc.tryAggregate(false, calls, {
          blockTag: atBlock
        });
      } catch (e) {
        log.warn(
          'Multicall failed; falling back to single calls for this chunk',
          { error: String(e) }
        );
        for (let j = 0; j < slice.length; j++) {
          try {
            const owner: string = await c.ownerOf(slice[j], {
              blockTag: atBlock
            });
            results[i + j] =
              owner && owner !== ethers.ZeroAddress
                ? owner.toLowerCase()
                : null;
          } catch {
            results[i + j] = null;
          }
        }
        continue;
      }

      for (let j = 0; j < ret.length; j++) {
        const r = ret[j];
        if (!r?.success || !r.returnData || r.returnData === '0x') {
          results[i + j] = null;
          continue;
        }
        try {
          const decoded: ethers.Result = erc721Iface.decodeFunctionResult(
            'ownerOf',
            r.returnData
          );
          const owner = (decoded[0] as string) ?? null;
          results[i + j] =
            owner && owner !== ethers.ZeroAddress ? owner.toLowerCase() : null;
        } catch {
          results[i + j] = null;
        }
      }
    }

    return results;
  }

  public async attemptSnapshot() {
    const log = this.logger;
    const jobKey = `${this.logger.name}#attempt`;
    const ctx: RequestContext = { timer: new Timer(jobKey) };

    const best = await this.getBestBlock();
    const reorgDepth = env.getIntOrThrow('NFT_INDEXER_REORG_DEPTH_BLOCKS');
    const safeHead = best - reorgDepth;

    const lockOwner = `snap-${randomUUID()}`;
    const nowMs = Time.currentMillis();

    const picked =
      await this.externalIndexingRepository.lockNextWaitingSnapshotJob(
        {
          snapshot_lock_owner: lockOwner,
          snapshot_target_block: safeHead,
          now_ms: nowMs
        },
        ctx
      );

    if (!picked) {
      log.info('No WAITING_FOR_SNAPSHOTTING job available right now');
      return;
    }

    log.info('Acquired snapshot job', {
      partition: picked.partition,
      chain: picked.chain,
      contract: picked.contract,
      at_block: picked.at_block,
      lockOwner
    });

    await this.snapshot({
      type: 'SnapshotCollection',
      chain: picked.chain,
      contract: picked.contract,
      atBlock: numbers.parseIntOrNull(picked.at_block),
      lockOwner
    });
  }

  private static readonly IFACE_ERC721 = '0x80ac58cd';
  private static readonly IFACE_ERC1155 = '0xd9b67a26';

  private async validateIndexable(
    contractAddr: string,
    atBlock: number
  ): Promise<{
    ok: boolean;
    standard?: IndexedContractStandard;
    adapter?: string | null;
    reason?: string;
  }> {
    const lc = contractAddr.toLowerCase();

    if (lc === CRYPTOPUNKS_MAINNET) {
      return {
        ok: true,
        standard: IndexedContractStandard.LEGACY_721,
        adapter: 'cryptopunks'
      };
    }

    try {
      const code = await this.rpc.provider.getCode(contractAddr, atBlock);
      if (!code || code === '0x') {
        return { ok: false, reason: 'No contract code at address' };
      }
    } catch {
      return { ok: false, reason: 'Failed to fetch contract code' };
    }

    const erc165 = new Contract(contractAddr, ERC165_ABI, this.rpc.provider);

    try {
      if (
        await erc165.supportsInterface(
          ExternalCollectionSnapshottingService.IFACE_ERC1155,
          { blockTag: atBlock }
        )
      ) {
        return { ok: false, reason: 'ERC-1155 collections are not supported' };
      }
    } catch {
      // ignore
    }

    try {
      if (
        await erc165.supportsInterface(
          ExternalCollectionSnapshottingService.IFACE_ERC721,
          { blockTag: atBlock }
        )
      ) {
        return {
          ok: true,
          standard: IndexedContractStandard.ERC721,
          adapter: null
        };
      }
    } catch {
      // fall through to probe
    }

    const erc721 = new Contract(contractAddr, ERC721_ABI, this.rpc.provider);
    const probeIds = [BigInt(0), BigInt(1)];
    for (const pid of probeIds) {
      try {
        await erc721.ownerOf(pid, { blockTag: atBlock });
        return {
          ok: true,
          standard: IndexedContractStandard.ERC721,
          adapter: null
        };
      } catch {
        /* keep trying */
      }
    }

    return {
      ok: false,
      reason: 'Contract does not support ERC-721 (ERC165 and probe failed)'
    };
  }
}

export const externalCollectionSnapshottingService =
  new ExternalCollectionSnapshottingService(
    externalIndexingRepository,
    externalIndexerRpc
  );
