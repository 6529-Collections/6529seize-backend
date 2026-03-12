import {
  ArtCurationHistoricalBackfillCandidateDrop,
  artCurationTokenWatchDb,
  ArtCurationTokenWatchDb,
  buildArtCurationActiveDedupeKey
} from '@/art-curation/art-curation-token-watch.db';
import {
  ArtCurationTokenTransferEvent,
  artCurationTokenWatchOnchainService,
  ArtCurationTokenWatchOnchainService
} from '@/art-curation/art-curation-token-watch.onchain';
import { DropNftLinkInsertModel } from '@/drops/drop-nft-links.db';
import {
  ArtCurationTokenWatchEntity,
  ArtCurationTokenWatchStatus
} from '@/entities/IArtCurationTokenWatch';
import { DropType } from '@/entities/IDrop';
import { WaveDecisionWinnerPrize } from '@/entities/IWaveDecision';
import { WaveEntity } from '@/entities/IWave';
import { env } from '@/env';
import { Logger } from '@/logging';
import { validateLinkUrl } from '@/nft-links/nft-link-resolver.validator';
import { RequestContext } from '@/request.context';
import { Time, Timer } from '@/time';
import { waveDecisionsDb, WaveDecisionsDb } from '@/waves/wave-decisions.db';
import {
  waveLeaderboardCalculationService,
  WaveLeaderboardCalculationService
} from '@/waves/wave-leaderboard-calculation.service';
import { randomUUID } from 'node:crypto';
import { dropsDb, DropsDb } from '@/drops/drops.db';
import { DropRealVoterVoteInTimeEntityWithoutId } from '@/entities/IDropRealVoterVoteInTime';
import { WinnerDropVoterVoteEntity } from '@/entities/IWinnerDropVoterVote';
import { dropVotingDb, DropVotingDb } from '@/api/drops/drop-voting.db';

const EMPTY_PRIZES: WaveDecisionWinnerPrize[] = [];

interface HistoricalBackfillTokenIdentifiers {
  readonly canonicalId: string;
  readonly chain: string;
  readonly contract: string;
  readonly tokenId: string;
}

interface HistoricalBackfillExecutionOptions {
  readonly dryRun?: boolean;
}

export class ArtCurationTokenWatchService {
  private readonly logger = Logger.get(this.constructor.name);

  public constructor(
    private readonly artCurationTokenWatchDb: ArtCurationTokenWatchDb,
    private readonly onchainService: ArtCurationTokenWatchOnchainService,
    private readonly dropVotingDb: DropVotingDb,
    private readonly dropsDb: DropsDb,
    private readonly waveDecisionsDb: WaveDecisionsDb,
    private readonly waveLeaderboardCalculationService: WaveLeaderboardCalculationService
  ) {}

  public isEnabledForWave(waveId: string): boolean {
    const configuredWaveId = env.getStringOrNull('ART_CURATIONS_WAVE_ID');
    return !!configuredWaveId && configuredWaveId === waveId;
  }

  public async registerDrop(
    {
      dropId,
      waveId,
      dropType,
      links
    }: {
      dropId: string;
      waveId: string;
      dropType: DropType;
      links: DropNftLinkInsertModel[];
    },
    ctx: RequestContext
  ): Promise<void> {
    if (!this.isEnabledForWave(waveId) || dropType !== DropType.PARTICIPATORY) {
      return;
    }
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

  public async processHistoricalBackfillCycle(
    timer: Timer,
    options?: HistoricalBackfillExecutionOptions
  ): Promise<number> {
    const waveId = env.getStringOrNull('ART_CURATIONS_WAVE_ID');
    if (!waveId) {
      return 0;
    }
    const dryRun = options?.dryRun ?? false;
    const ctx: RequestContext = { timer };
    const maxTokens =
      env.getIntOrNull('ART_CURATIONS_BACKFILL_MAX_TOKENS_PER_RUN') ?? 100;
    const canonicalIds =
      await this.artCurationTokenWatchDb.findHistoricalBackfillCandidateCanonicalIds(
        {
          waveId,
          limit: maxTokens
        },
        ctx
      );
    console.log(canonicalIds.length);
    if (!canonicalIds.length) {
      return 0;
    }
    const candidates =
      await this.artCurationTokenWatchDb.findHistoricalBackfillCandidateDrops(
        {
          waveId,
          canonicalIds
        },
        ctx
      );
    const candidatesByCanonicalId = new Map<
      string,
      ArtCurationHistoricalBackfillCandidateDrop[]
    >();
    for (const candidate of candidates) {
      const group = candidatesByCanonicalId.get(candidate.canonical_id) ?? [];
      group.push(candidate);
      candidatesByCanonicalId.set(candidate.canonical_id, group);
    }
    let processed = 0;
    for (const canonicalId of canonicalIds) {
      const group = candidatesByCanonicalId.get(canonicalId) ?? [];
      if (!group.length) {
        continue;
      }
      try {
        await this.processHistoricalBackfillCanonicalGroup(
          waveId,
          group,
          ctx,
          dryRun
        );
        processed++;
      } catch (error) {
        this.logger.error(
          `Failed historical Art Curation backfill for ${canonicalId}${dryRun ? ' [DRY_RUN]' : ''}`,
          error
        );
      }
    }
    return processed;
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
    await this.dropsDb.executeNativeQueriesInTransaction(async (connection) => {
      const txCtx: RequestContext = {
        timer: ctx.timer,
        connection
      };
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
          event
        },
        txCtx
      );
    });
  }

  private async processHistoricalBackfillCanonicalGroup(
    waveId: string,
    candidates: ArtCurationHistoricalBackfillCandidateDrop[],
    ctx: RequestContext,
    dryRun: boolean
  ): Promise<void> {
    const sortedCandidates = [...candidates].sort(
      (left, right) =>
        left.created_at - right.created_at ||
        left.drop_id.localeCompare(right.drop_id)
    );
    const token = this.parseTokenCanonicalId(sortedCandidates[0].canonical_id);
    if (!token) {
      this.logger.warn(
        `Skipping historical Art Curation backfill for ${sortedCandidates[0].canonical_id}. Canonical id is not a token${dryRun ? ' [DRY_RUN]' : ''}`
      );
      return;
    }
    this.logHistoricalBackfillGroupStart(token, sortedCandidates, dryRun);

    const firstSubmissionBlock =
      await this.onchainService.findLatestBlockBeforeTimestamp(
        sortedCandidates[0].created_at
      );
    const reorgDepth = env.getIntOrNull('NFT_INDEXER_REORG_DEPTH_BLOCKS') ?? 12;
    const maxRange =
      env.getIntOrNull('ART_CURATIONS_WATCH_BLOCK_RANGE') ?? 2000;
    const { safeHead, events } =
      await this.onchainService.findTransfersThroughSafeHead({
        contract: token.contract,
        tokenId: token.tokenId,
        fromBlock: firstSubmissionBlock.number + 1,
        reorgDepth,
        maxRange
      });

    let dropIndex = 0;
    let eventIndex = 0;

    while (dropIndex < sortedCandidates.length) {
      const sessionStartDrop = sortedCandidates[dropIndex];
      const sessionStartBlock =
        await this.onchainService.findLatestBlockBeforeTimestamp(
          sessionStartDrop.created_at
        );
      const submissionSnapshot =
        await this.onchainService.snapshotSubmissionStateAtBlock({
          contract: token.contract,
          tokenId: token.tokenId,
          blockNumber: sessionStartBlock.number,
          observedAt: sessionStartDrop.created_at
        });

      const remainingDrops = sortedCandidates.slice(dropIndex);
      if (!submissionSnapshot.isTrackable) {
        let watchId: string | null = null;
        if (!dryRun) {
          watchId = await this.cancelHistoricalBackfillDrops(
            {
              waveId,
              token,
              sessionStartBlock: sessionStartBlock.number,
              sessionStartTime: sessionStartDrop.created_at,
              ownerAtSubmission: submissionSnapshot.owner,
              drops: remainingDrops
            },
            ctx
          );
        }
        this.logHistoricalBackfillOutcome(
          'cancelled_untrackable',
          token,
          remainingDrops,
          {
            watchId,
            dryRun,
            sessionStartBlock: sessionStartBlock.number,
            sessionStartTime: sessionStartDrop.created_at
          }
        );
        return;
      }

      while (
        eventIndex < events.length &&
        events[eventIndex].timestampMs < sessionStartDrop.created_at
      ) {
        eventIndex++;
      }

      const event = events[eventIndex] ?? null;
      const sessionDrops: ArtCurationHistoricalBackfillCandidateDrop[] = [];
      while (dropIndex < sortedCandidates.length) {
        const candidate = sortedCandidates[dropIndex];
        if (event && candidate.created_at > event.timestampMs) {
          break;
        }
        sessionDrops.push(candidate);
        dropIndex++;
      }

      if (!sessionDrops.length) {
        break;
      }

      if (event) {
        let watchId: string | null = null;
        if (!dryRun) {
          watchId = await this.resolveHistoricalBackfillSession(
            {
              waveId,
              token,
              sessionStartBlock: sessionStartBlock.number,
              sessionStartTime: sessionStartDrop.created_at,
              ownerAtSubmission: submissionSnapshot.owner,
              drops: sessionDrops,
              event
            },
            ctx
          );
        }
        this.logHistoricalBackfillOutcome(
          'resolved_to_winner',
          token,
          sessionDrops,
          {
            watchId,
            dryRun,
            sessionStartBlock: sessionStartBlock.number,
            sessionStartTime: sessionStartDrop.created_at,
            triggerTime: event.timestampMs,
            triggerTxHash: event.txHash
          }
        );
        eventIndex++;
        continue;
      }

      const seededWatch = await this.seedHistoricalBackfillSession(
        {
          waveId,
          token,
          sessionStartBlock: sessionStartBlock.number,
          sessionStartTime: sessionStartDrop.created_at,
          ownerAtSubmission: submissionSnapshot.owner,
          lastCheckedBlock: Math.max(sessionStartBlock.number, safeHead),
          drops: sessionDrops,
          dryRun
        },
        ctx
      );
      this.logHistoricalBackfillOutcome(
        seededWatch.wasMergedIntoExistingWatch
          ? 'merged_into_active_watch'
          : 'seeded_active_watch',
        token,
        sessionDrops,
        {
          watchId: seededWatch.watchId,
          dryRun,
          sessionStartBlock: sessionStartBlock.number,
          sessionStartTime: sessionStartDrop.created_at,
          checkedThroughBlock: Math.max(sessionStartBlock.number, safeHead)
        }
      );
      return;
    }
  }

  private async resolveHistoricalBackfillSession(
    {
      waveId,
      token,
      sessionStartBlock,
      sessionStartTime,
      ownerAtSubmission,
      drops,
      event
    }: {
      waveId: string;
      token: HistoricalBackfillTokenIdentifiers;
      sessionStartBlock: number;
      sessionStartTime: number;
      ownerAtSubmission: string;
      drops: ArtCurationHistoricalBackfillCandidateDrop[];
      event: ArtCurationTokenTransferEvent;
    },
    ctx: RequestContext
  ): Promise<string> {
    return await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = {
          timer: ctx.timer,
          connection
        };
        const wave = await this.dropsDb.findWaveByIdOrNull(waveId, connection);
        if (!wave) {
          throw new Error(`Wave ${waveId} not found`);
        }
        const now = Time.currentMillis();
        const watch = this.buildHistoricalWatch({
          id: randomUUID(),
          waveId,
          token,
          ownerAtSubmission,
          startBlock: sessionStartBlock,
          startTime: sessionStartTime,
          lastCheckedBlock: event.blockNumber,
          status: ArtCurationTokenWatchStatus.ACTIVE,
          activeDedupeKey: null,
          createdAt: now,
          updatedAt: now
        });

        await this.artCurationTokenWatchDb.insertWatch(watch, txCtx);
        await this.attachHistoricalDropsToWatch(
          watch.id,
          ownerAtSubmission,
          drops,
          now,
          txCtx
        );
        await this.convertDropsToWinnersForTrigger(
          {
            watch,
            wave,
            dropIds: drops.map((drop) => drop.drop_id),
            event
          },
          txCtx
        );
        return watch.id;
      }
    );
  }

  private async seedHistoricalBackfillSession(
    {
      waveId,
      token,
      sessionStartBlock,
      sessionStartTime,
      ownerAtSubmission,
      lastCheckedBlock,
      drops,
      dryRun
    }: {
      waveId: string;
      token: HistoricalBackfillTokenIdentifiers;
      sessionStartBlock: number;
      sessionStartTime: number;
      ownerAtSubmission: string;
      lastCheckedBlock: number;
      drops: ArtCurationHistoricalBackfillCandidateDrop[];
      dryRun: boolean;
    },
    ctx: RequestContext
  ): Promise<{
    watchId: string | null;
    wasMergedIntoExistingWatch: boolean;
  }> {
    if (dryRun) {
      const activeDedupeKey = buildArtCurationActiveDedupeKey({
        waveId,
        chain: token.chain,
        contract: token.contract,
        tokenId: token.tokenId
      });
      const existingActive =
        await this.artCurationTokenWatchDb.findActiveByDedupeKey(
          activeDedupeKey,
          ctx
        );
      return {
        watchId: existingActive?.id ?? null,
        wasMergedIntoExistingWatch: !!existingActive
      };
    }
    return await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = {
          timer: ctx.timer,
          connection
        };
        const activeDedupeKey = buildArtCurationActiveDedupeKey({
          waveId,
          chain: token.chain,
          contract: token.contract,
          tokenId: token.tokenId
        });
        const existingActive =
          await this.artCurationTokenWatchDb.findActiveByDedupeKey(
            activeDedupeKey,
            txCtx
          );
        const now = Time.currentMillis();

        let watchId: string;
        let wasMergedIntoExistingWatch = false;
        if (existingActive) {
          const shouldUseHistoricalBaseline =
            sessionStartTime < existingActive.start_time;
          await this.artCurationTokenWatchDb.updateHistoricalBaseline(
            {
              watchId: existingActive.id,
              startBlock: shouldUseHistoricalBaseline
                ? sessionStartBlock
                : existingActive.start_block,
              startTime: shouldUseHistoricalBaseline
                ? sessionStartTime
                : existingActive.start_time,
              ownerAtSubmission: shouldUseHistoricalBaseline
                ? ownerAtSubmission
                : existingActive.owner_at_submission,
              lastCheckedBlock: Math.max(
                existingActive.last_checked_block,
                lastCheckedBlock
              )
            },
            txCtx
          );
          watchId = existingActive.id;
          wasMergedIntoExistingWatch = true;
        } else {
          const watch = this.buildHistoricalWatch({
            id: randomUUID(),
            waveId,
            token,
            ownerAtSubmission,
            startBlock: sessionStartBlock,
            startTime: sessionStartTime,
            lastCheckedBlock,
            status: ArtCurationTokenWatchStatus.ACTIVE,
            activeDedupeKey,
            createdAt: now,
            updatedAt: now
          });
          await this.artCurationTokenWatchDb.insertWatch(watch, txCtx);
          watchId = watch.id;
        }

        await this.attachHistoricalDropsToWatch(
          watchId,
          ownerAtSubmission,
          drops,
          now,
          txCtx
        );
        return {
          watchId,
          wasMergedIntoExistingWatch
        };
      }
    );
  }

  private async cancelHistoricalBackfillDrops(
    {
      waveId,
      token,
      sessionStartBlock,
      sessionStartTime,
      ownerAtSubmission,
      drops
    }: {
      waveId: string;
      token: HistoricalBackfillTokenIdentifiers;
      sessionStartBlock: number;
      sessionStartTime: number;
      ownerAtSubmission: string;
      drops: ArtCurationHistoricalBackfillCandidateDrop[];
    },
    ctx: RequestContext
  ): Promise<string> {
    return await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = {
          timer: ctx.timer,
          connection
        };
        const now = Time.currentMillis();
        const watch = this.buildHistoricalWatch({
          id: randomUUID(),
          waveId,
          token,
          ownerAtSubmission,
          startBlock: sessionStartBlock,
          startTime: sessionStartTime,
          lastCheckedBlock: sessionStartBlock,
          status: ArtCurationTokenWatchStatus.CANCELLED,
          activeDedupeKey: null,
          createdAt: now,
          updatedAt: now
        });
        await this.artCurationTokenWatchDb.insertWatch(watch, txCtx);
        await this.attachHistoricalDropsToWatch(
          watch.id,
          ownerAtSubmission,
          drops,
          now,
          txCtx
        );
        return watch.id;
      }
    );
  }

  private async attachHistoricalDropsToWatch(
    watchId: string,
    ownerAtSubmission: string,
    drops: ArtCurationHistoricalBackfillCandidateDrop[],
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    for (const drop of drops) {
      await this.artCurationTokenWatchDb.upsertDropWatch(
        {
          watch_id: watchId,
          drop_id: drop.drop_id,
          canonical_id: drop.canonical_id,
          url_in_text: drop.url_in_text,
          owner_at_submission: ownerAtSubmission,
          created_at: now,
          updated_at: now
        },
        ctx
      );
    }
  }

  private buildHistoricalWatch({
    id,
    waveId,
    token,
    ownerAtSubmission,
    startBlock,
    startTime,
    lastCheckedBlock,
    status,
    activeDedupeKey,
    createdAt,
    updatedAt
  }: {
    id: string;
    waveId: string;
    token: HistoricalBackfillTokenIdentifiers;
    ownerAtSubmission: string;
    startBlock: number;
    startTime: number;
    lastCheckedBlock: number;
    status: ArtCurationTokenWatchStatus;
    activeDedupeKey: string | null;
    createdAt: number;
    updatedAt: number;
  }): ArtCurationTokenWatchEntity {
    return {
      id,
      wave_id: waveId,
      canonical_id: token.canonicalId,
      chain: token.chain,
      contract: token.contract,
      token_id: token.tokenId,
      active_dedupe_key: activeDedupeKey,
      owner_at_submission: ownerAtSubmission,
      status,
      start_block: startBlock,
      start_time: startTime,
      last_checked_block: lastCheckedBlock,
      locked_at: null,
      resolved_at: null,
      trigger_tx_hash: null,
      trigger_block_number: null,
      trigger_log_index: null,
      trigger_time: null,
      created_at: createdAt,
      updated_at: updatedAt
    };
  }

  private parseTokenCanonicalId(
    canonicalId: string
  ): HistoricalBackfillTokenIdentifiers | null {
    const [platform, chain, contract, tokenId, ...rest] =
      canonicalId.split(':');
    if (!platform || !chain || !contract || !tokenId || rest.length) {
      return null;
    }
    if (!contract.startsWith('0x')) {
      return null;
    }
    return {
      canonicalId,
      chain,
      contract: contract.toLowerCase(),
      tokenId
    };
  }

  private logHistoricalBackfillGroupStart(
    token: HistoricalBackfillTokenIdentifiers,
    drops: ArtCurationHistoricalBackfillCandidateDrop[],
    dryRun: boolean
  ): void {
    const dropIds = drops.map((drop) => drop.drop_id).join(',');
    this.logger.info(
      `Historical Art Curation${dryRun ? ' DRY_RUN' : ''} backfill start canonical=${token.canonicalId} drops=${dropIds} action=scan_post_submission_transfers`
    );
  }

  private logHistoricalBackfillOutcome(
    outcome:
      | 'resolved_to_winner'
      | 'seeded_active_watch'
      | 'merged_into_active_watch'
      | 'cancelled_untrackable',
    token: HistoricalBackfillTokenIdentifiers,
    drops: ArtCurationHistoricalBackfillCandidateDrop[],
    {
      watchId,
      dryRun,
      sessionStartBlock,
      sessionStartTime,
      checkedThroughBlock,
      triggerTime,
      triggerTxHash
    }: {
      watchId?: string | null;
      dryRun: boolean;
      sessionStartBlock: number;
      sessionStartTime: number;
      checkedThroughBlock?: number;
      triggerTime?: number;
      triggerTxHash?: string;
    }
  ): void {
    const dropIds = drops.map((drop) => drop.drop_id);
    this.logger.info(
      `Historical Art Curation${dryRun ? ' DRY_RUN' : ''} session outcome=${outcome} canonical=${token.canonicalId} drops=${dropIds.join(',')} session_start_block=${sessionStartBlock} session_start_time=${sessionStartTime}${watchId ? ` watch_id=${watchId}` : ''}${checkedThroughBlock != null ? ` checked_through_block=${checkedThroughBlock}` : ''}${triggerTime != null ? ` trigger_time=${triggerTime}` : ''}${triggerTxHash ? ` trigger_tx=${triggerTxHash}` : ''}`
    );
    for (const dropId of dropIds) {
      this.logger.info(
        `Historical Art Curation${dryRun ? ' DRY_RUN' : ''} drop=${dropId} canonical=${token.canonicalId} outcome=${outcome}${watchId ? ` watch_id=${watchId}` : ''}${triggerTime != null ? ` trigger_time=${triggerTime}` : ''}${triggerTxHash ? ` trigger_tx=${triggerTxHash}` : ''}`
      );
    }
  }

  private async convertDropsToWinnersForTrigger(
    {
      watch,
      wave,
      dropIds,
      event
    }: {
      watch: ArtCurationTokenWatchEntity;
      wave: WaveEntity;
      dropIds: string[];
      event: ArtCurationTokenTransferEvent;
    },
    ctx: RequestContext
  ): Promise<void> {
    const decisionTime = event.timestampMs;
    const { finalVotesByDropId, winnerVotes } =
      await this.buildWinnerVoteArchive(
        {
          dropIds,
          wave,
          decisionTime
        },
        ctx
      );
    if (winnerVotes.length) {
      await this.dropVotingDb.insertWinnerDropsVoterVotes(winnerVotes, ctx);
    }
    await this.waveDecisionsDb.insertDecisionIfMissing(
      {
        decision_time: decisionTime,
        wave_id: wave.id
      },
      ctx
    );
    await this.waveDecisionsDb.insertDecisionWinners(
      dropIds.map((dropId) => ({
        drop_id: dropId,
        ranking: 1,
        decision_time: decisionTime,
        prizes: EMPTY_PRIZES,
        wave_id: wave.id,
        final_vote: finalVotesByDropId[dropId] ?? 0
      })),
      ctx
    );
    await this.waveDecisionsDb.updateDropsToWinners(dropIds, ctx);
    await this.waveDecisionsDb.deleteDropsRanks(dropIds, ctx);
    await this.dropsDb.resyncParticipatoryDropCountsForWaves([wave.id], ctx);
    await this.dropVotingDb.deleteStaleLeaderboardEntries(ctx);
    await this.artCurationTokenWatchDb.markResolved(
      {
        watchId: watch.id,
        resolvedAt: Time.currentMillis(),
        triggerTxHash: event.txHash,
        triggerBlockNumber: event.blockNumber,
        triggerLogIndex: event.logIndex,
        triggerTime: event.timestampMs
      },
      ctx
    );
    this.logger.info(
      `Resolved Art Curation watch ${watch.id} for ${dropIds.length} drops`
    );
  }

  private async buildWinnerVoteArchive(
    {
      dropIds,
      wave,
      decisionTime
    }: {
      dropIds: string[];
      wave: WaveEntity;
      decisionTime: number;
    },
    ctx: RequestContext
  ): Promise<{
    finalVotesByDropId: Record<string, number>;
    winnerVotes: WinnerDropVoterVoteEntity[];
  }> {
    if (!wave.time_lock_ms || wave.time_lock_ms <= 0) {
      const winnerVotes = await this.dropVotingDb.getCurrentVoterStatesForDrops(
        dropIds,
        ctx
      );
      const finalVotesByDropId = dropIds.reduce(
        (acc, dropId) => {
          acc[dropId] = 0;
          return acc;
        },
        {} as Record<string, number>
      );
      for (const vote of winnerVotes) {
        finalVotesByDropId[vote.drop_id] =
          (finalVotesByDropId[vote.drop_id] ?? 0) + vote.votes;
      }
      return {
        finalVotesByDropId,
        winnerVotes
      };
    }

    const startTime = Time.millis(decisionTime).minusMillis(wave.time_lock_ms);
    const endTime = Time.millis(decisionTime);
    const startTimeMillis = startTime.toMillis();
    const voteLogs =
      await this.dropVotingDb.getAllVoteChangeLogsForGivenDropsInTimeframe(
        {
          timeLockStart: startTimeMillis,
          dropIds
        },
        ctx
      );
    const winnerVotes: WinnerDropVoterVoteEntity[] = [];
    const finalVotesByDropId = dropIds.reduce(
      (acc, dropId) => {
        acc[dropId] = 0;
        return acc;
      },
      {} as Record<string, number>
    );

    for (const [dropId, votesByVoter] of Object.entries(voteLogs)) {
      for (const [voterId, voteStates] of Object.entries(votesByVoter)) {
        const transformed =
          voteStates.map<DropRealVoterVoteInTimeEntityWithoutId>((vote) => ({
            drop_id: dropId,
            voter_id: voterId,
            vote: vote.vote,
            timestamp: Math.max(vote.timestamp, startTimeMillis),
            wave_id: wave.id
          }));
        const finalVote =
          this.waveLeaderboardCalculationService.calculateFinalVoteForDrop({
            voteStates: transformed,
            startTime,
            endTime
          });
        finalVotesByDropId[dropId] =
          (finalVotesByDropId[dropId] ?? 0) + finalVote;
        if (finalVote !== 0) {
          winnerVotes.push({
            voter_id: voterId,
            drop_id: dropId,
            votes: finalVote,
            wave_id: wave.id
          });
        }
      }
    }

    return {
      finalVotesByDropId,
      winnerVotes
    };
  }
}

export const artCurationTokenWatchService = new ArtCurationTokenWatchService(
  artCurationTokenWatchDb,
  artCurationTokenWatchOnchainService,
  dropVotingDb,
  dropsDb,
  waveDecisionsDb,
  waveLeaderboardCalculationService
);
