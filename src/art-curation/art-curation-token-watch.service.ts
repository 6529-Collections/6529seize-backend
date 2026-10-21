import {
  artCurationTokenWatchDb,
  ArtCurationTokenWatchDb,
  buildArtCurationActiveDedupeKey
} from '@/art-curation/art-curation-token-watch.db';
import {
  ArtCurationTokenTransferEvent,
  ArtCurationTokenTransferPrice,
  artCurationTokenWatchOnchainService,
  ArtCurationTokenWatchOnchainService
} from '@/art-curation/art-curation-token-watch.onchain';
import { DropNftLinkInsertModel } from '@/drops/drop-nft-links.db';
import {
  ArtCurationTokenWatchEntity,
  ArtCurationTokenWatchStatus
} from '@/entities/IArtCurationTokenWatch';
import { DropType } from '@/entities/IDrop';
import { WaveEntity } from '@/entities/IWave';
import { env } from '@/env';
import { Logger } from '@/logging';
import { validateLinkUrl } from '@/nft-links/nft-link-resolver.validator';
import { RequestContext } from '@/request.context';
import { Time, Timer } from '@/time';
import { randomUUID } from 'node:crypto';
import { dropsDb, DropsDb } from '@/drops/drops.db';

import { competitionEntryRepository } from '@/competitions/competition-entry.repository';
import { competitionRepository } from '@/competitions/competition.repository';
import { nativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';
import { nativeCompetitionRuntimeService } from '@/competitions/native-competition-runtime.service';
import { CompetitionCapability } from '@/entities/ICompetition';

export class ArtCurationTokenWatchService {
  private readonly logger = Logger.get(this.constructor.name);

  public constructor(
    private readonly artCurationTokenWatchDb: ArtCurationTokenWatchDb,
    private readonly onchainService: ArtCurationTokenWatchOnchainService,
    private readonly dropsDb: DropsDb
  ) {}

  private async canRegisterDrop(
    dropId: string,
    waveId: string,
    dropType: DropType,
    competitionId: string | undefined,
    ctx: RequestContext
  ): Promise<boolean> {
    if (dropType !== DropType.PARTICIPATORY) return false;
    if (competitionId) return this.isNativeCuration(competitionId, waveId, ctx);
    const entries = await competitionEntryRepository.lockDropMemberships(
      dropId,
      ctx
    );
    for (const entry of entries) {
      if (
        entry.wave_id === waveId &&
        entry.status === 'ACTIVE' &&
        (await this.isNativeCuration(entry.competition_id, waveId, ctx))
      )
        return true;
    }
    return false;
  }

  private async isNativeCuration(
    competitionId: string,
    waveId: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const record = await competitionRepository.findCompetitionRecordById(
      competitionId,
      ctx
    );
    if (record?.storage_mode !== 'NATIVE' || record.wave_id !== waveId)
      return false;
    return (
      await competitionRepository.findCapabilities(competitionId, ctx)
    ).includes(CompetitionCapability.CURATION);
  }

  public async registerDrop(
    {
      dropId,
      waveId,
      dropType,
      competitionId,
      links
    }: {
      dropId: string;
      waveId: string;
      dropType: DropType;
      competitionId?: string;
      links: DropNftLinkInsertModel[];
    },
    ctx: RequestContext
  ): Promise<void> {
    if (
      !(await this.canRegisterDrop(
        dropId,
        waveId,
        dropType,
        competitionId,
        ctx
      ))
    )
      return;
    const previousWatchLink = await this.artCurationTokenWatchDb.findByDropId(
      dropId,
      ctx
    );
    if (links.length !== 1) {
      this.logger.warn(
        `Skipping Art Curation tracking for drop ${dropId}. Expected exactly one NFT link, got ${links.length}`
      );
      if (previousWatchLink) {
        await this.artCurationTokenWatchDb.detachDropFromWatch(dropId, ctx);
      }
      return;
    }
    const [link] = links;
    let canonical;
    try {
      canonical = validateLinkUrl(link.url_in_text);
    } catch {
      if (previousWatchLink) {
        await this.artCurationTokenWatchDb.detachDropFromWatch(dropId, ctx);
      }
      return;
    }
    if (canonical.identifiers.kind !== 'TOKEN') {
      if (previousWatchLink) {
        await this.artCurationTokenWatchDb.detachDropFromWatch(dropId, ctx);
      }
      return;
    }
    const { chain, contract, tokenId } = canonical.identifiers;
    const snapshot = await this.onchainService.snapshotSubmissionState({
      contract,
      tokenId
    });
    if (!snapshot.isTrackable) {
      this.logger.info(
        `Skipping Art Curation tracking for drop ${dropId}. Token ${canonical.canonicalId} is not trackable as ERC721`
      );
      if (previousWatchLink) {
        await this.artCurationTokenWatchDb.detachDropFromWatch(dropId, ctx);
      }
      return;
    }
    const now = Time.currentMillis();
    const watch = await this.artCurationTokenWatchDb.upsertActiveWatchAndGet(
      {
        id: randomUUID(),
        wave_id: waveId,
        canonical_id: canonical.canonicalId,
        chain,
        contract,
        token_id: tokenId,
        active_dedupe_key: buildArtCurationActiveDedupeKey({
          waveId,
          chain,
          contract,
          tokenId
        }),
        owner_at_submission: snapshot.owner,
        status: ArtCurationTokenWatchStatus.ACTIVE,
        start_block: snapshot.blockNumber,
        start_time: snapshot.observedAt,
        last_checked_block: snapshot.blockNumber,
        locked_at: null,
        resolved_at: null,
        trigger_tx_hash: null,
        trigger_block_number: null,
        trigger_log_index: null,
        trigger_time: null,
        trigger_price_raw: null,
        trigger_price: null,
        trigger_price_currency: null,
        created_at: now,
        updated_at: now
      },
      ctx
    );
    await this.artCurationTokenWatchDb.upsertDropWatch(
      {
        watch_id: watch.id,
        drop_id: dropId,
        canonical_id: canonical.canonicalId,
        url_in_text: link.url_in_text,
        owner_at_submission: snapshot.owner,
        created_at: now,
        updated_at: now
      },
      ctx
    );
    if (previousWatchLink && previousWatchLink.watch_id !== watch.id) {
      await this.artCurationTokenWatchDb.cancelIfEmpty(
        previousWatchLink.watch_id,
        ctx
      );
    }
  }

  public async unregisterDrop(
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.artCurationTokenWatchDb.detachDropFromWatch(dropId, ctx);
  }

  public async processCycle(timer: Timer): Promise<number> {
    const ctx: RequestContext = { timer };
    const lockTtlMs =
      env.getIntOrNull('ART_CURATIONS_WATCH_LOCK_TTL_MS') ??
      Time.minutes(15).toMillis();
    const maxPerCycle =
      env.getIntOrNull('ART_CURATIONS_WATCH_MAX_PER_CYCLE') ?? 50;
    let processed = 0;
    const seenWatchIds = new Set<string>();
    while (processed < maxPerCycle) {
      const watch = await this.artCurationTokenWatchDb.lockNextActiveWatch(
        {
          lockTtlMs,
          excludedWatchIds: Array.from(seenWatchIds)
        },
        ctx
      );
      if (!watch) {
        break;
      }
      seenWatchIds.add(watch.id);
      try {
        await this.processLockedWatch(watch, ctx);
      } catch (error) {
        this.logger.error(
          `Failed processing Art Curation watch ${watch.id}`,
          error
        );
        await this.artCurationTokenWatchDb.unlock(watch.id, ctx);
      }
      processed++;
    }
    return processed;
  }

  private async processLockedWatch(
    watch: ArtCurationTokenWatchEntity,
    ctx: RequestContext
  ): Promise<void> {
    const reorgDepth = env.getIntOrNull('NFT_INDEXER_REORG_DEPTH_BLOCKS') ?? 12;
    const maxRange =
      env.getIntOrNull('ART_CURATIONS_WATCH_BLOCK_RANGE') ?? 2000;
    const { checkedThroughBlock, event } =
      await this.onchainService.findFirstTransfer({
        contract: watch.contract,
        tokenId: watch.token_id,
        fromBlock: watch.last_checked_block + 1,
        reorgDepth,
        maxRange
      });
    if (!event) {
      if (checkedThroughBlock > watch.last_checked_block) {
        await this.artCurationTokenWatchDb.markChecked(
          {
            watchId: watch.id,
            lastCheckedBlock: checkedThroughBlock
          },
          ctx
        );
      } else {
        await this.artCurationTokenWatchDb.unlock(watch.id, ctx);
      }
      return;
    }
    let transferPrice: ArtCurationTokenTransferPrice = {
      amountRaw: null,
      amount: null,
      currency: null
    };
    try {
      transferPrice = await this.onchainService.findTransferPrice({
        txHash: event.txHash,
        contract: watch.contract,
        tokenId: watch.token_id
      });
    } catch (error) {
      this.logger.warn(
        `Failed determining Art Curation transfer price for watch ${watch.id}`,
        error
      );
    }
    await this.dropsDb.executeNativeQueriesInTransaction(async (connection) => {
      const txCtx: RequestContext = {
        timer: ctx.timer,
        connection
      };
      // Entry commands lock competitions before watches. Keep the same order.
      const records = await competitionRepository.listCompetitionRecordsForWave(
        watch.wave_id,
        txCtx
      );
      const competitions = [];
      for (const record of [...records].sort((a, b) =>
        a.id.localeCompare(b.id)
      )) {
        const competition =
          await nativeCompetitionRuntimeRepository.lockCompetition(
            record.id,
            txCtx
          );
        if (competition?.capabilities.includes(CompetitionCapability.CURATION))
          competitions.push(competition);
      }
      if (!competitions.length)
        throw new Error('Curation watch has no native capability owner');
      const lockedWatch = await this.artCurationTokenWatchDb.findByIdForUpdate(
        watch.id,
        txCtx
      );
      if (lockedWatch?.status !== ArtCurationTokenWatchStatus.ACTIVE) {
        return;
      }
      const dropIds =
        await this.artCurationTokenWatchDb.findTrackedParticipatoryDropIds(
          watch.id,
          txCtx
        );
      if (!dropIds.length) {
        await this.artCurationTokenWatchDb.cancel(watch.id, txCtx);
        return;
      }
      const wave = await this.dropsDb.findWaveByIdOrNull(
        lockedWatch.wave_id,
        connection
      );
      if (!wave) {
        await this.artCurationTokenWatchDb.cancel(watch.id, txCtx);
        return;
      }
      await this.convertDropsToWinnersForTrigger(
        {
          watch: lockedWatch,
          wave,
          dropIds,
          event,
          transferPrice,
          competitionIds: competitions.map((competition) => competition.id)
        },
        txCtx
      );
    });
  }

  private async convertDropsToWinnersForTrigger(
    {
      watch,
      wave,
      dropIds,
      event,
      transferPrice,
      competitionIds
    }: {
      watch: ArtCurationTokenWatchEntity;
      wave: WaveEntity;
      dropIds: string[];
      event: ArtCurationTokenTransferEvent;
      transferPrice: ArtCurationTokenTransferPrice;
      competitionIds: string[];
    },
    ctx: RequestContext
  ): Promise<void> {
    const decisionTime = event.timestampMs;
    for (const competitionId of competitionIds) {
      const resolved =
        await nativeCompetitionRuntimeService.resolveCurationEntries(
          competitionId,
          dropIds,
          decisionTime,
          `curation:${watch.id}:${event.txHash}:${event.logIndex}`,
          ctx
        );
      if (!resolved) {
        await this.artCurationTokenWatchDb.unlock(watch.id, ctx);
        return;
      }
    }
    await this.dropsDb.resyncParticipatoryDropCountsForWaves([wave.id], ctx);
    await this.artCurationTokenWatchDb.markResolved(
      {
        watchId: watch.id,
        resolvedAt: Time.currentMillis(),
        triggerTxHash: event.txHash,
        triggerBlockNumber: event.blockNumber,
        triggerLogIndex: event.logIndex,
        triggerTime: event.timestampMs,
        triggerPriceRaw: transferPrice.amountRaw,
        triggerPrice: transferPrice.amount,
        triggerPriceCurrency: transferPrice.currency
      },
      ctx
    );
    this.logger.info(
      `Resolved Art Curation watch ${watch.id} for ${dropIds.length} drops`
    );
  }
}

export const artCurationTokenWatchService = new ArtCurationTokenWatchService(
  artCurationTokenWatchDb,
  artCurationTokenWatchOnchainService,
  dropsDb
);
