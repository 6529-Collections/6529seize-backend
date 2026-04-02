import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from './sql-executor';
import { identitiesDb } from './identities/identities.db';
import { IdentityEntity } from './entities/IIdentity';
import { profilesService } from './profiles/profiles.service';
import { Profile } from './entities/IProfile';
import { Logger } from './logging';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE,
  RATINGS_TABLE
} from '@/constants';
import { randomUUID } from 'node:crypto';
import { identitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import {
  identitiesService,
  IdentitiesService
} from '@/api/identities/identities.service';
import { numbers } from './numbers';
import { collections } from './collections';
import { profilesDb } from './profiles/profiles.db';
import { dropsDb, IdentityNominationDrop } from './drops/drops.db';
import { dropVotingDb } from '@/api/drops/drop-voting.db';
import { deleteDrop } from './drops/delete-drop.use-case';
import {
  WaveEntity,
  WaveIdentitySubmissionDuplicates,
  WaveIdentitySubmissionStrategy,
  WaveSubmissionType
} from '@/entities/IWave';
import { wavesApiDb } from '@/api-serverless/src/waves/waves.api.db';

const logger = Logger.get('IDENTITIES');

type IdentityMergeTarget = {
  sourceIdentities: IdentityEntity[];
  targetIdentity: IdentityEntity;
  originalIdentity: IdentityEntity | null;
};

type DropTally = {
  tally: number;
  total_number_of_voters: number;
};

type DropTalliesById = Record<string, DropTally>;

type IdentitySubmissionCleanupWave = Pick<WaveEntity, 'id'> & {
  readonly submission_type: WaveSubmissionType.IDENTITY;
  readonly identity_submission_strategy: WaveIdentitySubmissionStrategy;
  readonly identity_submission_duplicates: WaveIdentitySubmissionDuplicates;
};

export type ProfileRetentionCandidate = {
  consolidationKey: string;
  tdh: number | string;
};

export class ProfileIdGenerator {
  public generate(): string {
    return randomUUID();
  }
}

const profileIdGenerator = new ProfileIdGenerator();

export class IdentityConsolidationEffects extends LazyDbAccessCompatibleService {
  public constructor(
    dbSupplier: () => SqlExecutor,
    private readonly profileIdGenerator: ProfileIdGenerator,
    private readonly identitiesService: IdentitiesService
  ) {
    super(dbSupplier);
  }

  private isActiveIdentityNomination(
    nomination: Pick<IdentityNominationDrop, 'has_won'>
  ): boolean {
    return !nomination.has_won;
  }

  private async getUnsynchronisedConsolidationKeysWithTdhs(
    connection: ConnectionWrapper<any>
  ): Promise<
    {
      consolidation_key: string;
      tdh: number;
    }[]
  > {
    const db = dbSupplier();
    return await db.execute<{
      consolidation_key: string;
      tdh: number;
    }>(
      `
    select t.consolidation_key, floor(t.boosted_tdh) as tdh from tdh_consolidation t
      left join address_consolidation_keys a on t.consolidation_key = a.consolidation_key
      where a.consolidation_key is null
  `,
      undefined,
      { wrappedConnection: connection }
    );
  }

  private mergeDuplicates(
    identitiesToSave: IdentityEntity[]
  ): IdentityEntity[] {
    return Object.values(
      identitiesToSave.reduce(
        (acc, it) => {
          const profileId = it.profile_id;
          if (profileId == null) {
            throw new Error('Expected identity to have a profile_id');
          }
          if (!acc[profileId]) {
            acc[profileId] = it;
          } else {
            const oldIdentity = acc[profileId];
            if (oldIdentity.tdh < it.tdh) {
              const newProfileId = this.profileIdGenerator.generate();
              const oldIdentitiesNewVersion: IdentityEntity = {
                ...oldIdentity,
                profile_id: newProfileId,
                handle: null,
                normalised_handle: null,
                rep: 0,
                cic: 0,
                level_raw: oldIdentity.level_raw - oldIdentity.rep,
                classification: null,
                sub_classification: null,
                banner1: null,
                banner2: null,
                pfp: null
              };
              acc[profileId] = it;
              acc[newProfileId] = oldIdentitiesNewVersion;
            } else {
              const newProfileId = this.profileIdGenerator.generate();
              acc[newProfileId] = {
                ...it,
                profile_id: newProfileId,
                handle: null,
                normalised_handle: null,
                rep: 0,
                cic: 0,
                level_raw: it.level_raw - it.rep,
                classification: null,
                sub_classification: null,
                banner1: null,
                banner2: null,
                pfp: null
              };
            }
          }
          return acc;
        },
        {} as Record<string, IdentityEntity>
      )
    );
  }

  private consolidationContainsWallet(
    consolidationKey: string,
    wallet: string | null | undefined
  ): boolean {
    if (!wallet) {
      return false;
    }
    return consolidationKey
      .split('-')
      .some((it) => it.toLowerCase() === wallet.toLowerCase());
  }

  private detachIdentityFromProfile(identity: IdentityEntity): IdentityEntity {
    const newProfileId = this.profileIdGenerator.generate();
    return {
      ...identity,
      profile_id: newProfileId,
      handle: null,
      normalised_handle: null,
      rep: 0,
      cic: 0,
      level_raw: identity.level_raw - identity.rep,
      classification: null,
      sub_classification: null,
      banner1: null,
      banner2: null,
      pfp: null
    };
  }

  private selectProfileRetentionConsolidation({
    candidates,
    delegatedPrimaryAddress,
    previousPrimaryAddress
  }: {
    candidates: ProfileRetentionCandidate[];
    delegatedPrimaryAddress: string | null;
    previousPrimaryAddress: string | null;
  }): string {
    if (candidates.length === 0) {
      throw new Error('Expected at least one profile retention candidate');
    }

    const normalizedCandidates = candidates.map((candidate) => ({
      consolidationKey: candidate.consolidationKey,
      tdh: numbers.parseNumberOrThrow(candidate.tdh)
    }));

    const delegatedPrimaryCandidate = delegatedPrimaryAddress
      ? normalizedCandidates.find((candidate) =>
          this.consolidationContainsWallet(
            candidate.consolidationKey,
            delegatedPrimaryAddress
          )
        )
      : null;
    if (delegatedPrimaryCandidate) {
      return delegatedPrimaryCandidate.consolidationKey;
    }

    const highestTdh = Math.max(
      ...normalizedCandidates.map((candidate) => candidate.tdh)
    );
    const highestTdhCandidates = normalizedCandidates.filter(
      (candidate) => candidate.tdh === highestTdh
    );

    if (highestTdhCandidates.length === 1) {
      return highestTdhCandidates[0].consolidationKey;
    }

    const previousPrimaryCandidate = previousPrimaryAddress
      ? highestTdhCandidates.find((candidate) =>
          this.consolidationContainsWallet(
            candidate.consolidationKey,
            previousPrimaryAddress
          )
        )
      : null;
    if (previousPrimaryCandidate) {
      return previousPrimaryCandidate.consolidationKey;
    }

    return highestTdhCandidates
      .map((candidate) => candidate.consolidationKey)
      .sort((a, b) => a.localeCompare(b))[0];
  }

  private async getActiveDelegatedPrimaryAddress(
    consolidationKey: string
  ): Promise<string | null> {
    const { getDelegationPrimaryAddressForConsolidation } =
      await import('./delegationsLoop/db.delegations');
    return await getDelegationPrimaryAddressForConsolidation(consolidationKey);
  }

  private async applyExplicitProfileRetention(
    identitiesToMerge: IdentityMergeTarget[]
  ) {
    const mergeGroups = Object.values(
      identitiesToMerge.reduce(
        (acc, mergeTarget) => {
          const profileId = mergeTarget.targetIdentity.profile_id;
          if (profileId) {
            acc[profileId] = acc[profileId] ?? [];
            acc[profileId].push(mergeTarget);
          }
          return acc;
        },
        {} as Record<string, IdentityMergeTarget[]>
      )
    );

    for (const mergeGroup of mergeGroups) {
      if (mergeGroup.length < 2) {
        continue;
      }

      const originalIdentity = mergeGroup[0].originalIdentity;
      if (!originalIdentity) {
        continue;
      }

      const delegatedPrimaryAddress =
        await this.getActiveDelegatedPrimaryAddress(
          originalIdentity.consolidation_key
        );
      const retainedConsolidationKey = this.selectProfileRetentionConsolidation(
        {
          candidates: mergeGroup.map((candidate) => ({
            consolidationKey: candidate.targetIdentity.consolidation_key,
            tdh: candidate.targetIdentity.tdh
          })),
          delegatedPrimaryAddress,
          previousPrimaryAddress: originalIdentity.primary_address
        }
      );

      for (const mergeTarget of mergeGroup) {
        try {
          if (
            mergeTarget.targetIdentity.consolidation_key.toLowerCase() !==
            retainedConsolidationKey.toLowerCase()
          ) {
            mergeTarget.targetIdentity = this.detachIdentityFromProfile(
              mergeTarget.targetIdentity
            );
          }
        } catch (e: any) {
          logger.error({
            event: 'identity_profile_retention_selection_failed',
            merge_group: mergeGroup,
            merge_target: mergeTarget,
            error: e instanceof Error ? e.message : e
          });
          throw e;
        }
      }
    }
  }

  private async syncIdentityMetadataFromMergedProfiles(
    identitiesToMerge: IdentityMergeTarget[],
    connection: ConnectionWrapper<any>
  ) {
    const mergeTargetsWithProfiles = collections
      .distinct(
        identitiesToMerge
          .filter((mergeTarget) => mergeTarget.sourceIdentities.length > 0)
          .map((mergeTarget) => mergeTarget.targetIdentity.profile_id)
          .filter((profileId): profileId is string => !!profileId)
      )
      .reduce(
        (acc, profileId) => {
          const mergeTarget = identitiesToMerge.find(
            (it) => it.targetIdentity.profile_id === profileId
          );
          if (mergeTarget) {
            acc.push({
              consolidationKey: mergeTarget.targetIdentity.consolidation_key,
              profileId
            });
          }
          return acc;
        },
        [] as {
          consolidationKey: string;
          profileId: string;
        }[]
      );

    for (const mergeTarget of mergeTargetsWithProfiles) {
      const profile = await profilesDb.getProfileById(
        mergeTarget.profileId,
        connection
      );
      if (profile) {
        await identitiesDb.updateIdentityProfile(
          mergeTarget.consolidationKey,
          {
            profile_id: profile.external_id,
            handle: profile.handle,
            classification: profile.classification ?? null,
            normalised_handle: profile.normalised_handle,
            sub_classification: profile.sub_classification ?? null,
            banner1: profile.banner_1 ?? null,
            banner2: profile.banner_2 ?? null,
            pfp: profile.pfp_url ?? null
          },
          connection
        );
      }
    }

    await this.syncIdentityNominationsFromMergedProfiles(
      identitiesToMerge,
      connection
    );
  }

  private async syncIdentityNominationsFromMergedProfiles(
    identitiesToMerge: IdentityMergeTarget[],
    connection: ConnectionWrapper<any>
  ) {
    for (const mergeTarget of identitiesToMerge) {
      const targetProfileId = mergeTarget.targetIdentity.profile_id;
      const consolidatedProfileIds = collections.distinct(
        [
          targetProfileId,
          ...mergeTarget.sourceIdentities.map((it) => it.profile_id)
        ].filter((profileId): profileId is string => !!profileId)
      );
      const sourceProfileIds = mergeTarget.sourceIdentities
        .map((it) => it.profile_id)
        .filter((profileId): profileId is string => !!profileId);
      if (!targetProfileId || sourceProfileIds.length === 0) {
        continue;
      }
      logger.info({
        event: 'identity_consolidation_nomination_sync_started',
        target_profile_id: targetProfileId,
        source_profile_ids: sourceProfileIds,
        consolidated_profile_ids: consolidatedProfileIds
      });
      const targetProfile = await profilesDb.getProfileById(
        targetProfileId,
        connection
      );
      if (!targetProfile) {
        logger.warn({
          event:
            'identity_consolidation_nomination_sync_skipped_missing_target_profile',
          target_profile_id: targetProfileId,
          source_profile_ids: sourceProfileIds,
          consolidated_profile_ids: consolidatedProfileIds
        });
        continue;
      }

      const affectedWaveIds =
        await dropsDb.findIdentityNominationWaveIdsByProfileIds(
          [targetProfileId, ...sourceProfileIds],
          { connection }
        );
      logger.info({
        event: 'identity_consolidation_nomination_sync_affected_waves_resolved',
        target_profile_id: targetProfileId,
        source_profile_ids: sourceProfileIds,
        consolidated_profile_ids: consolidatedProfileIds,
        affected_wave_ids: collections.distinct(affectedWaveIds)
      });
      for (const waveId of collections.distinct(affectedWaveIds)) {
        const wave = await wavesApiDb.findWaveById(waveId, connection);
        if (
          !wave ||
          wave.submission_type !== WaveSubmissionType.IDENTITY ||
          wave.identity_submission_duplicates === null ||
          wave.identity_submission_strategy === null
        ) {
          logger.info({
            event:
              'identity_consolidation_nomination_cleanup_skipped_wave_not_identity_submission',
            wave_id: waveId,
            target_profile_id: targetProfileId,
            consolidated_profile_ids: consolidatedProfileIds
          });
          continue;
        }
        for (const sourceProfileId of sourceProfileIds) {
          await dropsDb.updateIdentityNominationProfileId(
            {
              waveId,
              sourceProfileId,
              targetProfileId
            },
            { connection }
          );
          logger.info({
            event: 'identity_consolidation_nomination_profile_rewritten',
            wave_id: waveId,
            source_profile_id: sourceProfileId,
            target_profile_id: targetProfileId,
            consolidated_profile_ids: consolidatedProfileIds,
            note: 'only non-winning participatory nominations in identity-submission waves are rewritten'
          });
        }
        await this.cleanupConsolidatedIdentityNominations(
          {
            wave: wave as IdentitySubmissionCleanupWave,
            consolidatedProfileIds
          },
          connection
        );
      }
    }
  }

  private async cleanupConsolidatedIdentityNominations(
    {
      wave,
      consolidatedProfileIds
    }: {
      wave: IdentitySubmissionCleanupWave;
      consolidatedProfileIds: string[];
    },
    connection: ConnectionWrapper<any>
  ) {
    let nominations =
      await this.getIdentityNominationsForConsolidatedProfilesInWave(
        {
          consolidatedProfileIds,
          waveId: wave.id
        },
        connection
      );
    logger.info({
      event: 'identity_consolidation_wave_cleanup_started',
      wave_id: wave.id,
      consolidated_profile_ids: consolidatedProfileIds,
      identity_submission_strategy: wave.identity_submission_strategy,
      identity_submission_duplicates: wave.identity_submission_duplicates,
      nominations: nominations.map((it) => this.nominationLog(it))
    });

    if (!nominations.length) {
      logger.info({
        event: 'identity_consolidation_wave_cleanup_no_nominations',
        wave_id: wave.id,
        consolidated_profile_ids: consolidatedProfileIds,
        identity_submission_strategy: wave.identity_submission_strategy,
        identity_submission_duplicates: wave.identity_submission_duplicates
      });
      return;
    }

    if (
      wave.identity_submission_strategy ===
      WaveIdentitySubmissionStrategy.ONLY_OTHERS
    ) {
      const selfNominations = nominations.filter(
        (it) => !it.has_won && consolidatedProfileIds.includes(it.author_id)
      );
      if (selfNominations.length > 0) {
        logger.info({
          event: 'identity_consolidation_only_others_self_nomination_cleanup',
          wave_id: wave.id,
          consolidated_profile_ids: consolidatedProfileIds,
          reason:
            'ONLY_OTHERS requires deleting participatory nominations whose author is in the consolidated nominee set',
          deleted_nominations: selfNominations.map((it) =>
            this.nominationLog(it)
          ),
          surviving_nominations: nominations
            .filter(
              (it) =>
                !selfNominations.some(
                  (deleted) => deleted.drop_id === it.drop_id
                )
            )
            .map((it) => this.nominationLog(it))
        });
      }
      await this.deleteIdentityNominations(
        selfNominations,
        {
          waveId: wave.id,
          consolidatedProfileIds,
          reason:
            'ONLY_OTHERS cleanup removed a participatory self-nomination created by consolidation',
          duplicatesPolicy: wave.identity_submission_duplicates,
          strategy: wave.identity_submission_strategy
        },
        connection
      );
      const deletedDropIds = new Set(selfNominations.map((it) => it.drop_id));
      nominations = nominations.filter((it) => !deletedDropIds.has(it.drop_id));
    }

    const winningNominations = nominations.filter((it) => it.has_won);
    const participatoryNominations = nominations.filter(
      this.isActiveIdentityNomination
    );

    switch (wave.identity_submission_duplicates) {
      case WaveIdentitySubmissionDuplicates.ALWAYS_ALLOW:
        logger.info({
          event: 'identity_consolidation_duplicate_cleanup_skipped',
          wave_id: wave.id,
          consolidated_profile_ids: consolidatedProfileIds,
          reason:
            'duplicates policy ALWAYS_ALLOW keeps all surviving nominations',
          nominations: nominations.map((it) => this.nominationLog(it))
        });
        return;
      case WaveIdentitySubmissionDuplicates.ALLOW_AFTER_WIN:
        if (participatoryNominations.length < 2) {
          logger.info({
            event: 'identity_consolidation_duplicate_cleanup_skipped',
            wave_id: wave.id,
            consolidated_profile_ids: consolidatedProfileIds,
            reason:
              'duplicates policy ALLOW_AFTER_WIN allows prior winners but keeps at most one active participatory nomination',
            winning_nominations: winningNominations.map((it) =>
              this.nominationLog(it)
            ),
            participatory_nominations: participatoryNominations.map((it) =>
              this.nominationLog(it)
            )
          });
          return;
        }
        await this.deleteIdentityNominationDuplicates(
          participatoryNominations,
          {
            waveId: wave.id,
            consolidatedProfileIds,
            reason:
              'duplicates policy ALLOW_AFTER_WIN keeps the highest-tally active participatory nomination while preserving winners',
            duplicatesPolicy: wave.identity_submission_duplicates,
            strategy: wave.identity_submission_strategy
          },
          connection
        );
        return;
      case WaveIdentitySubmissionDuplicates.NEVER_ALLOW:
        if (winningNominations.length > 0) {
          logger.info({
            event:
              'identity_consolidation_duplicate_cleanup_delete_participatory',
            wave_id: wave.id,
            consolidated_profile_ids: consolidatedProfileIds,
            reason:
              'duplicates policy NEVER_ALLOW deletes all participatory nominations because a winner already exists',
            winning_nominations: winningNominations.map((it) =>
              this.nominationLog(it)
            ),
            deleted_participatory_nominations: participatoryNominations.map(
              (it) => this.nominationLog(it)
            )
          });
          await this.deleteIdentityNominations(
            participatoryNominations,
            {
              waveId: wave.id,
              consolidatedProfileIds,
              reason:
                'duplicates policy NEVER_ALLOW removed a participatory nomination because a winner already exists',
              duplicatesPolicy: wave.identity_submission_duplicates,
              strategy: wave.identity_submission_strategy
            },
            connection
          );
          return;
        }
        await this.deleteIdentityNominationDuplicates(
          participatoryNominations,
          {
            waveId: wave.id,
            consolidatedProfileIds,
            reason:
              'duplicates policy NEVER_ALLOW keeps only the highest-tally participatory nomination because no winner exists',
            duplicatesPolicy: wave.identity_submission_duplicates,
            strategy: wave.identity_submission_strategy
          },
          connection
        );
        return;
    }
  }

  private async getIdentityNominationsForConsolidatedProfilesInWave(
    {
      consolidatedProfileIds,
      waveId
    }: {
      consolidatedProfileIds: string[];
      waveId: string;
    },
    connection: ConnectionWrapper<any>
  ): Promise<IdentityNominationDrop[]> {
    const nominationsByProfile = await Promise.all(
      consolidatedProfileIds.map((profileId) =>
        dropsDb.findIdentityNominationDropsForWave(
          {
            waveId,
            profileId
          },
          { connection }
        )
      )
    );

    return Object.values(
      nominationsByProfile.flat().reduce(
        (acc, nomination) => {
          acc[nomination.drop_id] = nomination;
          return acc;
        },
        {} as Record<string, IdentityNominationDrop>
      )
    );
  }

  private async deleteIdentityNominationDuplicates(
    nominations: IdentityNominationDrop[],
    logContext: {
      waveId: string;
      consolidatedProfileIds: string[];
      reason: string;
      duplicatesPolicy: WaveIdentitySubmissionDuplicates;
      strategy: WaveIdentitySubmissionStrategy;
    },
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const duplicateResolution = await this.getIdentityNominationDuplicates(
      nominations,
      connection
    );
    if (!duplicateResolution) {
      logger.info({
        event: 'identity_consolidation_duplicate_cleanup_skipped',
        wave_id: logContext.waveId,
        consolidated_profile_ids: logContext.consolidatedProfileIds,
        reason:
          'fewer than two participatory nominations remained after cleanup',
        nominations: nominations.map((it) => this.nominationLog(it))
      });
      return;
    }

    logger.info({
      event: 'identity_consolidation_duplicate_resolution',
      wave_id: logContext.waveId,
      consolidated_profile_ids: logContext.consolidatedProfileIds,
      duplicates_policy: logContext.duplicatesPolicy,
      identity_submission_strategy: logContext.strategy,
      reason: logContext.reason,
      kept_nomination: this.nominationLog(
        duplicateResolution.keptNomination,
        duplicateResolution.talliesByDropId
      ),
      deleted_nominations: duplicateResolution.duplicateNominations.map(
        (it) => ({
          ...this.nominationLog(it, duplicateResolution.talliesByDropId),
          decision_basis: this.describeDuplicateResolutionDecision(
            duplicateResolution.keptNomination,
            it,
            duplicateResolution.talliesByDropId
          )
        })
      ),
      ranked_candidates: duplicateResolution.rankedNominations.map((it) =>
        this.nominationLog(it, duplicateResolution.talliesByDropId)
      )
    });

    await this.deleteIdentityNominations(
      duplicateResolution.duplicateNominations,
      {
        ...logContext,
        keptNomination: duplicateResolution.keptNomination,
        talliesByDropId: duplicateResolution.talliesByDropId
      },
      connection
    );
  }

  private async getIdentityNominationDuplicates(
    nominations: IdentityNominationDrop[],
    connection: ConnectionWrapper<any>
  ): Promise<{
    keptNomination: IdentityNominationDrop;
    duplicateNominations: IdentityNominationDrop[];
    rankedNominations: IdentityNominationDrop[];
    talliesByDropId: DropTalliesById;
  } | null> {
    if (nominations.length < 2) {
      return null;
    }

    const talliesByDropId = await dropVotingDb.getTallyForDrops(
      { dropIds: nominations.map((it) => it.drop_id) },
      { connection }
    );

    const rankedNominations = [...nominations].sort((left, right) => {
      const tallyDiff =
        (talliesByDropId[right.drop_id]?.tally ?? 0) -
        (talliesByDropId[left.drop_id]?.tally ?? 0);
      if (tallyDiff !== 0) {
        return tallyDiff;
      }
      if (left.created_at !== right.created_at) {
        return left.created_at - right.created_at;
      }
      if (left.serial_no !== right.serial_no) {
        return left.serial_no - right.serial_no;
      }
      return left.drop_id.localeCompare(right.drop_id);
    });

    return {
      keptNomination: rankedNominations[0],
      duplicateNominations: rankedNominations.slice(1),
      rankedNominations,
      talliesByDropId
    };
  }

  private async deleteIdentityNominations(
    nominations: IdentityNominationDrop[],
    logContext: {
      waveId: string;
      consolidatedProfileIds: string[];
      reason: string;
      duplicatesPolicy: WaveIdentitySubmissionDuplicates;
      strategy: WaveIdentitySubmissionStrategy;
      keptNomination?: IdentityNominationDrop;
      talliesByDropId?: DropTalliesById;
    },
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    for (const nomination of nominations) {
      logger.info({
        event: 'identity_consolidation_nomination_deleted',
        wave_id: logContext.waveId,
        consolidated_profile_ids: logContext.consolidatedProfileIds,
        duplicates_policy: logContext.duplicatesPolicy,
        identity_submission_strategy: logContext.strategy,
        reason: logContext.reason,
        deleted_nomination: {
          ...this.nominationLog(nomination, logContext.talliesByDropId),
          decision_basis: logContext.keptNomination
            ? this.describeDuplicateResolutionDecision(
                logContext.keptNomination,
                nomination,
                logContext.talliesByDropId ?? {}
              )
            : null
        },
        kept_nomination: logContext.keptNomination
          ? this.nominationLog(
              logContext.keptNomination,
              logContext.talliesByDropId
            )
          : null
      });
      await deleteDrop.execute(
        {
          drop_id: nomination.drop_id,
          deletion_purpose: 'SYSTEM_DELETE'
        },
        { connection }
      );
    }
  }

  private nominationLog(
    nomination: IdentityNominationDrop,
    talliesByDropId?: DropTalliesById
  ) {
    return {
      drop_id: nomination.drop_id,
      author_id: nomination.author_id,
      nominated_profile_id: nomination.nominated_profile_id,
      wave_id: nomination.wave_id,
      has_won: nomination.has_won,
      created_at: nomination.created_at,
      serial_no: nomination.serial_no,
      current_tally: talliesByDropId?.[nomination.drop_id]?.tally ?? null,
      total_number_of_voters:
        talliesByDropId?.[nomination.drop_id]?.total_number_of_voters ?? null
    };
  }

  private describeDuplicateResolutionDecision(
    keptNomination: IdentityNominationDrop,
    deletedNomination: IdentityNominationDrop,
    talliesByDropId: DropTalliesById
  ): string {
    const keptTally = talliesByDropId[keptNomination.drop_id]?.tally ?? 0;
    const deletedTally = talliesByDropId[deletedNomination.drop_id]?.tally ?? 0;
    if (keptTally !== deletedTally) {
      return `kept drop ${keptNomination.drop_id} because it had a higher current tally (${keptTally} > ${deletedTally})`;
    }
    if (keptNomination.created_at !== deletedNomination.created_at) {
      return `kept drop ${keptNomination.drop_id} because it was older by created_at (${keptNomination.created_at} < ${deletedNomination.created_at})`;
    }
    if (keptNomination.serial_no !== deletedNomination.serial_no) {
      return `kept drop ${keptNomination.drop_id} because it had a lower serial_no (${keptNomination.serial_no} < ${deletedNomination.serial_no})`;
    }
    return `kept drop ${keptNomination.drop_id} because it won the deterministic drop_id tie-break (${keptNomination.drop_id} < ${deletedNomination.drop_id})`;
  }

  public async syncIdentitiesWithTdhConsolidations(
    connection: ConnectionWrapper<any>
  ) {
    logger.info(`Syncing identities with tdh_consolidations`);
    const newConsolidations =
      await this.getUnsynchronisedConsolidationKeysWithTdhs(connection);

    if (newConsolidations.length) {
      const addressesInNewConsolidationKeys = newConsolidations
        .map((it) => it.consolidation_key.split('-'))
        .flat();
      const oldDataByWallets =
        await identitiesDb.getEverythingRelatedToIdentitiesByAddresses(
          addressesInNewConsolidationKeys,
          connection
        );
      const { brandNewConsolidations, consolidationsThatNeedWork } =
        newConsolidations.reduce(
          (acc, newConsolidation) => {
            const newConsolidationsWallets =
              newConsolidation.consolidation_key.split('-');
            const isRepresentedInOldConsolidations =
              newConsolidationsWallets.some(
                (wallet) => oldDataByWallets[wallet]
              );
            if (isRepresentedInOldConsolidations) {
              acc.consolidationsThatNeedWork.push(newConsolidation);
            } else {
              acc.brandNewConsolidations.push(newConsolidation);
            }
            return acc;
          },
          {
            brandNewConsolidations: [] as {
              consolidation_key: string;
              tdh: number;
            }[],
            consolidationsThatNeedWork: [] as {
              consolidation_key: string;
              tdh: number;
            }[]
          }
        );
      const brandNewIdentities: IdentityEntity[] = await Promise.all(
        brandNewConsolidations.map<Promise<IdentityEntity>>((consolidation) =>
          this.identitiesService
            .determinePrimaryAddress(
              consolidation.consolidation_key.split('-'),
              consolidation.consolidation_key
            )
            .then((primaryAddress) => {
              return {
                consolidation_key: consolidation.consolidation_key,
                primary_address: primaryAddress,
                profile_id: this.profileIdGenerator.generate(),
                handle: null,
                normalised_handle: null,
                tdh: consolidation.tdh,
                rep: 0,
                cic: 0,
                level_raw: consolidation.tdh,
                pfp: null,
                banner1: null,
                banner2: null,
                classification: null,
                sub_classification: null,
                xtdh: 0,
                produced_xtdh: 0,
                granted_xtdh: 0,
                xtdh_rate: 0,
                basetdh_rate: 0
              };
            })
        )
      );
      const identitiesToMerge: IdentityMergeTarget[] = [];
      for (const consolidationThatNeedsWork of consolidationsThatNeedWork) {
        const walletsForConsolidationThatNeedsWork =
          consolidationThatNeedsWork.consolidation_key.split('-');
        const newPrimaryAddress =
          await this.identitiesService.determinePrimaryAddress(
            walletsForConsolidationThatNeedsWork,
            consolidationThatNeedsWork.consolidation_key
          );
        const originalIdentity =
          oldDataByWallets[newPrimaryAddress]?.identity ??
          walletsForConsolidationThatNeedsWork
            .map((wallet) => oldDataByWallets[wallet]?.identity ?? null)
            .find((identity) => !!identity) ??
          null;
        let targetIdentity = originalIdentity ?? {
          consolidation_key: consolidationThatNeedsWork.consolidation_key,
          primary_address: newPrimaryAddress,
          profile_id: this.profileIdGenerator.generate(),
          handle: null,
          normalised_handle: null,
          tdh: consolidationThatNeedsWork.tdh,
          produced_xtdh: 0,
          granted_xtdh: 0,
          xtdh: 0,
          xtdh_rate: 0,
          basetdh_rate: 0,
          rep: 0,
          cic: 0,
          level_raw: consolidationThatNeedsWork.tdh,
          pfp: null,
          banner1: null,
          banner2: null,
          classification: null,
          sub_classification: null
        };
        const existingIdentityDataForConsolidation =
          walletsForConsolidationThatNeedsWork
            .map((wallet) => oldDataByWallets[wallet])
            .filter(
              (data): data is NonNullable<(typeof oldDataByWallets)[string]> =>
                !!data
            );
        const mainProfileForNewConsolidation =
          existingIdentityDataForConsolidation.reduce(
            (acc, data) => {
              const thisProfile = data.profile;
              const thisCic = numbers.parseIntOrNull(`${data.identity.cic}`);
              const thisTdh = numbers.parseIntOrNull(`${data.identity.tdh}`);
              if (!thisProfile || thisCic === null || thisTdh === null) {
                return acc;
              }
              if (
                !acc ||
                thisCic > acc.cic ||
                (thisCic === acc.cic && thisTdh > acc.tdh)
              ) {
                return { ...thisProfile, cic: thisCic, tdh: thisTdh };
              }
              return acc;
            },
            null as (Profile & { cic: number; tdh: number }) | null
          );
        targetIdentity = {
          ...targetIdentity,
          consolidation_key: consolidationThatNeedsWork.consolidation_key,
          tdh: consolidationThatNeedsWork.tdh,
          handle: mainProfileForNewConsolidation?.handle ?? null,
          normalised_handle:
            mainProfileForNewConsolidation?.normalised_handle ?? null,
          pfp: mainProfileForNewConsolidation?.pfp_url ?? null,
          banner1: mainProfileForNewConsolidation?.banner_1 ?? null,
          banner2: mainProfileForNewConsolidation?.banner_2 ?? null,
          classification:
            mainProfileForNewConsolidation?.classification ?? null,
          sub_classification:
            mainProfileForNewConsolidation?.sub_classification ?? null
        };
        const sourceIdentities = existingIdentityDataForConsolidation
          .filter((it) => it.identity.profile_id !== targetIdentity.profile_id)
          .map((it) => it.identity);
        identitiesToMerge.push({
          sourceIdentities,
          targetIdentity,
          originalIdentity
        });
      }
      await this.applyExplicitProfileRetention(identitiesToMerge);
      const allOldWallets = collections.distinct(
        Object.values(oldDataByWallets)
          .map((it) => it.identity.consolidation_key.split('-'))
          .flat()
      );
      for (const address of allOldWallets) {
        const newIdentity =
          brandNewIdentities.find((it) =>
            it.consolidation_key.split('-').includes(address)
          ) ??
          identitiesToMerge.find((it) =>
            it.targetIdentity.consolidation_key.split('-').includes(address)
          );
        if (!newIdentity) {
          brandNewIdentities.push({
            consolidation_key: address,
            primary_address: address,
            profile_id: this.profileIdGenerator.generate(),
            handle: null,
            normalised_handle: null,
            tdh: 0,
            rep: 0,
            cic: 0,
            level_raw: 0,
            pfp: null,
            banner1: null,
            banner2: null,
            classification: null,
            sub_classification: null,
            xtdh: 0,
            produced_xtdh: 0,
            granted_xtdh: 0,
            xtdh_rate: 0,
            basetdh_rate: 0
          });
        }
      }
      await identitiesDb.deleteAddressConsolidations(allOldWallets, connection);
      const allOldConsolidationKeys = collections.distinct(
        Object.values(oldDataByWallets).map(
          (it) => it.identity.consolidation_key
        )
      );
      await identitiesDb.deleteIdentities(
        { consolidationKeys: allOldConsolidationKeys },
        connection
      );
      brandNewIdentities.push(
        ...identitiesToMerge.map((it) => it.targetIdentity)
      );
      const identitiesToSave: IdentityEntity[] = await Promise.all(
        brandNewIdentities.map((it) =>
          this.identitiesService
            .determinePrimaryAddress(
              it.consolidation_key.split('-'),
              it.consolidation_key
            )
            .then((primaryAddress) => ({
              ...it,
              primary_address: primaryAddress
            }))
        )
      );
      const identitiesReadyForSaving = this.mergeDuplicates(identitiesToSave);
      await identitiesDb.bulkInsertIdentities(
        identitiesReadyForSaving,
        connection
      );
      for (const identitiesToMergeElement of identitiesToMerge) {
        const toBeMerged = identitiesToMergeElement.sourceIdentities
          .map((it) => it.profile_id)
          .filter((profileId): profileId is string => !!profileId);
        const targetProfileId =
          identitiesToMergeElement.targetIdentity.profile_id;
        if (!targetProfileId || toBeMerged.length === 0) {
          continue;
        }
        await profilesService.mergeProfileSet(
          {
            toBeMerged,
            target: targetProfileId
          },
          connection
        );
      }
      await this.syncIdentityMetadataFromMergedProfiles(
        identitiesToMerge,
        connection
      );
      if (identitiesToMerge.length > 0) {
        await identitySubscriptionsDb.resyncWaveSubscriptionsMetrics(
          connection
        );
      }
      await identitiesDb.syncProfileAddressesFromIdentitiesToProfiles(
        connection
      );
    }
    logger.info(`Syncing identities with tdh_consolidations done!`);
  }

  public async syncIdentitiesMetrics(connection: ConnectionWrapper<any>) {
    logger.info(`Syncing identities metrics`);
    const db = dbSupplier();
    await db.execute(
      `
    with cs as (
        select matter_target_id as profile_id, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'REP' group by 1
    )
    update ${IDENTITIES_TABLE} i
        inner join cs on cs.profile_id = i.profile_id
    set i.rep = cs.rating
    where cs.rating <> i.rep
  `,
      undefined,
      { wrappedConnection: connection }
    );
    await db.execute(
      `
    with profiles_with_rep as (
        select distinct matter_target_id as profile_id
        from ${RATINGS_TABLE}
        where matter = 'REP'
    )
    update ${IDENTITIES_TABLE} i
        left join profiles_with_rep on profiles_with_rep.profile_id = i.profile_id
    set i.rep = 0
    where i.rep <> 0
      and profiles_with_rep.profile_id is null
  `,
      undefined,
      { wrappedConnection: connection }
    );
    await db.execute(
      `
        with cs as (
            select matter_target_id as profile_id, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'CIC' group by 1
        )
        update ${IDENTITIES_TABLE} i
            inner join cs on cs.profile_id = i.profile_id
        set i.cic = cs.rating
        where cs.rating <> i.cic
  `,
      undefined,
      { wrappedConnection: connection }
    );
    await db.execute(
      `
        with profiles_with_cic as (
            select distinct matter_target_id as profile_id
            from ${RATINGS_TABLE}
            where matter = 'CIC'
        )
        update ${IDENTITIES_TABLE} i
            left join profiles_with_cic on profiles_with_cic.profile_id = i.profile_id
        set i.cic = 0
        where i.cic <> 0
          and profiles_with_cic.profile_id is null
  `,
      undefined,
      { wrappedConnection: connection }
    );
    await db.execute(
      `update ${IDENTITIES_TABLE} set tdh = 0, basetdh_rate = 0`,
      undefined,
      { wrappedConnection: connection }
    );
    await db.execute(
      `
     update ${IDENTITIES_TABLE} i
            inner join ${CONSOLIDATED_WALLETS_TDH_TABLE} c  on c.consolidation_key = i.consolidation_key
        set i.tdh = c.boosted_tdh, i.basetdh_rate = c.boosted_tdh_rate
        where i.consolidation_key = c.consolidation_key
  `,
      undefined,
      { wrappedConnection: connection }
    );
    await this.updateAllIdentitiesLevels(connection);
    logger.info(`Syncing identities metrics done`);
  }

  public async updateAllIdentitiesLevels(connection: ConnectionWrapper<any>) {
    const db = dbSupplier();
    await db.execute(
      `
        update ${IDENTITIES_TABLE} set level_raw = (rep+tdh+xtdh) where level_raw <> (rep+tdh+xtdh)
  `,
      undefined,
      { wrappedConnection: connection }
    );
  }
}

export const identityConsolidationEffects = new IdentityConsolidationEffects(
  dbSupplier,
  profileIdGenerator,
  identitiesService
);
