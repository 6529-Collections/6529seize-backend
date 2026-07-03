import {
  ACTIVITY_EVENTS_TABLE,
  DROP_BOOSTS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_MENTIONED_WAVES_TABLE,
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROP_RELATIONS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  IDENTITY_MUTES_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  NFTS_TABLE,
  OFFICIAL_WAVES_TABLE,
  PINNED_WAVES_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_CHAT_DROP_COOLDOWNS_TABLE,
  WAVE_METRICS_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVE_OUTCOMES_TABLE,
  WAVE_READER_METRICS_TABLE,
  WAVE_VOTING_CREDIT_NFTS_ARCHIVE_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  WAVES_ARCHIVE_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  WAVES_DECISIONS_TABLE,
  WAVES_TABLE
} from '@/constants';
import {
  groupWaveVotingCreditNftsByContract,
  normalizeWaveVotingCreditNfts,
  waveVotingCreditNftKey,
  WaveVotingCreditNft
} from '@/waves/wave-voting-credit-nfts';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import { DropType } from '../../../entities/IDrop';
import {
  WaveDecisionPauseEntity,
  WaveEntity,
  WaveOutcomeDistributionItemEntity,
  WaveOutcomeEntity
} from '../../../entities/IWave';
import { WaveDropperMetricEntity } from '../../../entities/IWaveDropperMetric';
import { WaveChatDropCooldownEntity } from '@/entities/IWaveChatDropCooldown';
import { WaveMetricEntity } from '../../../entities/IWaveMetric';
import { WaveReaderMetricEntity } from '../../../entities/IWaveReaderMetric';
import { RequestContext } from '../../../request.context';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { Time } from '../../../time';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { ApiWavesPinFilter } from '../generated/models/ApiWavesPinFilter';
import { ApiWaveScoreSort } from '../generated/models/ApiWaveScoreSort';
import { ApiWaveVisibilityTier } from '../generated/models/ApiWaveVisibilityTier';
import {
  readWaveUnreadSummaryCache,
  WaveUnreadSummary,
  withInFlightWaveUnreadSummaryCacheMiss,
  writeWaveUnreadSummaryCache
} from './wave-unread-cache';
import {
  withFollowedSubwaveOverviewContextCache,
  withInFlightFollowedSubwaveUnreadRead
} from './wave-followed-subwave-overview-cache';

type RawWaveEntity = Omit<
  WaveEntity,
  | 'participation_required_media'
  | 'participation_required_metadata'
  | 'decisions_strategy'
> & {
  participation_required_media: string;
  participation_required_metadata: string;
  decisions_strategy: string;
};

type RawWaveEntityWithLastDropTime = RawWaveEntity & {
  last_drop_time: number;
};

type WaveEntityWithLastDropTime = WaveEntity & {
  last_drop_time: number;
};

type WaveVotingCreditNftRow = {
  wave_id: string;
  contract: string;
  token_id: number;
};

type WaveChatDropCooldownPolicyRow = {
  wave_id: string;
  chat_slow_mode_cooldown_ms: number | string | null;
  latest_drop_timestamp: number | string | null;
  stored_next_drop_timestamp: number | string | null;
  stored_created_at: number | string | null;
  stored_updated_at: number | string | null;
};

type FollowedSubwaveActivityRow = {
  parent_wave_id: string;
  followed_subwaves_count: number | string;
  latest_followed_subwave_activity_timestamp: number | string | null;
};

type HiddenFollowedSubwaveUnreadRow = {
  parent_wave_id: string;
  hidden_followed_subwave_unread_drops: number | string;
  first_hidden_followed_subwave_unread_drop_serial_no: number | string | null;
};

type WaveUnreadSummaryRow = {
  wave_id: string;
  unread_drops_count: number | string;
  first_unread_drop_serial_no: number | string | null;
};

type UnreadDmDropsCountRow = {
  count: number | string;
};

export interface FollowedSubwaveOverviewContext {
  readonly followed_subwaves_count: number;
  readonly latest_followed_subwave_activity_timestamp: number | null;
  readonly hidden_followed_subwave_unread_drops: number;
  readonly first_hidden_followed_subwave_unread_drop_serial_no: number | null;
}

export enum WaveSubwavesSort {
  NAME = 'NAME',
  CREATED_AT = 'CREATED_AT'
}

export interface WaveMentionOverview {
  id: string;
  name: string;
  picture: string | null;
  visibility_group_id: string | null;
  participation_group_id: string | null;
  chat_group_id: string | null;
  admin_group_id: string | null;
  voting_group_id: string | null;
  is_direct_message: boolean | null;
}

export class WavesApiDb extends LazyDbAccessCompatibleService {
  private getWaveScoreSortColumn(sort: ApiWaveScoreSort): string {
    switch (sort) {
      case ApiWaveScoreSort.Quality:
        return 'wm.wave_quality_score';
      case ApiWaveScoreSort.Hotness:
        return 'wm.wave_hotness_score';
      case ApiWaveScoreSort.Rep:
        return 'wm.wave_rep_sort_score';
      case ApiWaveScoreSort.Balanced:
        return 'wm.wave_visibility_score';
    }
  }

  private getWaveVisibilityFilter(
    alias: string,
    groupIds: readonly string[],
    groupIdsParamName: string
  ): string {
    return `(${alias}.visibility_group_id is null ${
      groupIds.length
        ? `or ${alias}.visibility_group_id in (:${groupIdsParamName})`
        : ``
    })`;
  }

  private getWaveAndParentVisibilityFilter(
    waveAlias: string,
    parentAlias: string,
    groupIds: readonly string[],
    groupIdsParamName: string
  ): string {
    return `${this.getWaveVisibilityFilter(
      waveAlias,
      groupIds,
      groupIdsParamName
    )} and (${waveAlias}.parent_wave_id is null or (${parentAlias}.id is not null and ${parentAlias}.parent_wave_id is null and ${this.getWaveVisibilityFilter(
      parentAlias,
      groupIds,
      groupIdsParamName
    )}))`;
  }

  private toNullableNumber(
    value: number | string | null | undefined
  ): number | null {
    return value === null || value === undefined ? null : Number(value);
  }

  private toActivityTimestamp(
    value: number | string | null | undefined
  ): number | null {
    const numericValue = this.toNullableNumber(value);
    return numericValue !== null && numericValue > 0 ? numericValue : null;
  }

  private getFollowedSubwaveActivitySelect({
    groupIds,
    identityParamName,
    eligibleGroupsParamName,
    parentWaveIdsParamName
  }: {
    groupIds: readonly string[];
    identityParamName: string;
    eligibleGroupsParamName: string;
    parentWaveIdsParamName?: string;
  }): string {
    return `
      select
        child.parent_wave_id,
        count(distinct child.id) as followed_subwaves_count,
        max(
          case
            when coalesce(parent_wrm.muted, false) = true then 0
            when coalesce(child_wrm.muted, false) = true then 0
            else coalesce(child_wm.latest_drop_timestamp, 0)
          end
        ) as latest_followed_subwave_activity_timestamp
      from ${WAVES_TABLE} child
      join ${WAVES_TABLE} parent
        on parent.id = child.parent_wave_id
       and parent.parent_wave_id is null
      join ${IDENTITY_SUBSCRIPTIONS_TABLE} child_follow
        on child_follow.subscriber_id = :${identityParamName}
       and child_follow.target_id = child.id
       and child_follow.target_type = :wave_target_type
       and child_follow.target_action = :drop_created_action
      left join ${WAVE_METRICS_TABLE} child_wm
        on child_wm.wave_id = child.id
      left join ${WAVE_READER_METRICS_TABLE} parent_wrm
        on parent_wrm.wave_id = parent.id
       and parent_wrm.reader_id = :${identityParamName}
      left join ${WAVE_READER_METRICS_TABLE} child_wrm
        on child_wrm.wave_id = child.id
       and child_wrm.reader_id = :${identityParamName}
      where ${this.getWaveVisibilityFilter(
        'child',
        groupIds,
        eligibleGroupsParamName
      )}
        and ${this.getWaveVisibilityFilter(
          'parent',
          groupIds,
          eligibleGroupsParamName
        )}
        ${
          parentWaveIdsParamName
            ? `and child.parent_wave_id in (:${parentWaveIdsParamName})`
            : ``
        }
      group by child.parent_wave_id
    `;
  }

  private getFollowedSubwaveActivityCte({
    groupIds,
    identityParamName,
    eligibleGroupsParamName
  }: {
    groupIds: readonly string[];
    identityParamName: string;
    eligibleGroupsParamName: string;
  }): string {
    return `
      followed_subwave_activity as (
        ${this.getFollowedSubwaveActivitySelect({
          groupIds,
          identityParamName,
          eligibleGroupsParamName
        })}
      )
    `;
  }

  private resolveWaveChatDropCooldownPolicy(
    row: Pick<
      WaveChatDropCooldownPolicyRow,
      'chat_slow_mode_cooldown_ms' | 'latest_drop_timestamp'
    >
  ): {
    cooldownMs: number | null;
    latestDropTimestamp: number | null;
    nextDropTimestamp: number;
  } {
    const cooldownMs = this.toNullableNumber(row.chat_slow_mode_cooldown_ms);
    const latestDropTimestamp = this.toNullableNumber(
      row.latest_drop_timestamp
    );
    const nextDropTimestamp =
      latestDropTimestamp !== null && cooldownMs !== null && cooldownMs > 0
        ? latestDropTimestamp + cooldownMs
        : 0;
    return { cooldownMs, latestDropTimestamp, nextDropTimestamp };
  }

  private parseWaveEntity(entity: RawWaveEntity): WaveEntity {
    return {
      ...entity,
      participation_required_media: JSON.parse(
        entity.participation_required_media
      ),
      participation_required_metadata: JSON.parse(
        entity.participation_required_metadata
      ),
      decisions_strategy: entity.decisions_strategy
        ? JSON.parse(entity.decisions_strategy)
        : null
    };
  }

  private parseWaveEntityWithLastDropTime(
    entity: RawWaveEntityWithLastDropTime
  ): WaveEntityWithLastDropTime {
    return {
      ...this.parseWaveEntity(entity),
      last_drop_time: entity.last_drop_time
    };
  }

  public async findWaveById(
    id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<WaveEntityWithLastDropTime | null> {
    return this.db
      .oneOrNull<RawWaveEntityWithLastDropTime>(
        `SELECT w.*, COALESCE(wm.latest_drop_timestamp, 0) as last_drop_time
         FROM ${WAVES_TABLE} w
         LEFT JOIN ${WAVE_METRICS_TABLE} wm ON wm.wave_id = w.id
         WHERE w.id = :id`,
        { id },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it) => (it ? this.parseWaveEntityWithLastDropTime(it) : null));
  }

  public async findWaveByIdForUpdate(
    id: string,
    ctx: RequestContext
  ): Promise<WaveEntity | null> {
    const connection = ctx.connection;
    if (!connection) {
      throw new Error('findWaveByIdForUpdate requires a connection');
    }
    const timerKey = `${this.constructor.name}->findWaveByIdForUpdate`;
    ctx.timer?.start(timerKey);
    try {
      return await this.db
        .oneOrNull<RawWaveEntity>(
          `SELECT w.*
           FROM ${WAVES_TABLE} w
           WHERE w.id = :id
           FOR UPDATE`,
          { id },
          { wrappedConnection: connection }
        )
        .then((it) => (it ? this.parseWaveEntity(it) : null));
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findWavesByIds(
    ids: string[],
    groupIdsUserIsEligibleFor: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<WaveEntity[]> {
    if (!ids.length) {
      return [];
    }
    const visibilityFilter = this.getWaveAndParentVisibilityFilter(
      'w',
      'pw',
      groupIdsUserIsEligibleFor,
      'groupIdsUserIsEligibleFor'
    );
    return this.db
      .execute<RawWaveEntity>(
        `SELECT w.*
         FROM ${WAVES_TABLE} w
         LEFT JOIN ${WAVES_TABLE} pw ON pw.id = w.parent_wave_id
         WHERE w.id in (:ids)
           and ${visibilityFilter}`,
        { ids, groupIdsUserIsEligibleFor },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((res) => res.map((it) => this.parseWaveEntity(it)));
  }

  public async findWavesByIdsEligibleForRead(
    ids: string[],
    groupIdsUserIsEligibleFor: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<WaveEntityWithLastDropTime[]> {
    if (!ids.length) {
      return [];
    }
    const visibilityFilter = this.getWaveAndParentVisibilityFilter(
      'w',
      'pw',
      groupIdsUserIsEligibleFor,
      'groupIdsUserIsEligibleFor'
    );
    return this.db
      .execute<RawWaveEntityWithLastDropTime>(
        `SELECT w.*, COALESCE(wm.latest_drop_timestamp, 0) as last_drop_time
         FROM ${WAVES_TABLE} w
         LEFT JOIN ${WAVES_TABLE} pw ON pw.id = w.parent_wave_id
         LEFT JOIN ${WAVE_METRICS_TABLE} wm ON wm.wave_id = w.id
         WHERE w.id in (:ids)
           and ${visibilityFilter}`,
        { ids, groupIdsUserIsEligibleFor },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((res) => res.map((it) => this.parseWaveEntityWithLastDropTime(it)));
  }

  public async findWaveMentionOverviewsByIds(
    ids: string[],
    groupIdsUserIsEligibleFor: string[],
    ctx: RequestContext
  ): Promise<Record<string, WaveMentionOverview>> {
    if (!ids.length) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->findWaveMentionOverviewsByIds`);
    try {
      const rows = await this.db.execute<WaveMentionOverview>(
        `
        select
          w.id,
          w.name,
          w.picture,
          w.visibility_group_id,
          w.participation_group_id,
          w.chat_group_id,
          w.admin_group_id,
          w.voting_group_id,
          w.is_direct_message
        from ${WAVES_TABLE} w
        left join ${WAVES_TABLE} pw on pw.id = w.parent_wave_id
        where w.id in (:ids)
          and ${this.getWaveAndParentVisibilityFilter(
            'w',
            'pw',
            groupIdsUserIsEligibleFor,
            'groupIdsUserIsEligibleFor'
          )}
      `,
        { ids, groupIdsUserIsEligibleFor },
        { wrappedConnection: ctx.connection }
      );
      return rows.reduce(
        (acc, row) => {
          acc[row.id] = row;
          return acc;
        },
        {} as Record<string, WaveMentionOverview>
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->findWaveMentionOverviewsByIds`
      );
    }
  }

  public async findOfficialWaves(
    eligibleGroups: string[],
    ctx: RequestContext
  ): Promise<WaveEntity[]> {
    const timerKey = `${this.constructor.name}->findOfficialWaves`;
    ctx.timer?.start(timerKey);
    try {
      const rows = await this.db.execute<RawWaveEntity>(
        `
          select w.*
          from ${OFFICIAL_WAVES_TABLE} ow
            join ${WAVES_TABLE} w on w.id = ow.wave_id
            left join ${WAVES_TABLE} parent on parent.id = w.parent_wave_id
          where ${this.getWaveAndParentVisibilityFilter(
            'w',
            'parent',
            eligibleGroups,
            'eligibleGroups'
          )}
          order by w.serial_no desc, w.id asc
        `,
        { eligibleGroups },
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
      return rows.map((row) => this.parseWaveEntity(row));
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async insertWave(wave: InsertWaveEntity, ctx: RequestContext) {
    const connection = ctx.connection;
    if (!connection) {
      throw new Error('insertWave requires a connection');
    }
    ctx.timer?.start('waveApiDb->insertWave');
    const params = {
      ...wave,
      participation_required_media: JSON.stringify(
        wave.participation_required_media
      ),
      participation_required_metadata: JSON.stringify(
        wave.participation_required_metadata
      ),
      decisions_strategy: wave.decisions_strategy
        ? JSON.stringify(wave.decisions_strategy)
        : null
    };
    const serial = await this.db
      .execute(
        `
          insert into ${WAVES_TABLE}
          (id,
           name,
           parent_wave_id,
           picture,
           description_drop_id,
           created_at,
           updated_at,
           created_by,
           voting_group_id,
           admin_group_id,
           voting_credit_type,
           voting_credit_scope,
           voting_credit_category,
           voting_credit_creditor,
           voting_signature_required,
           voting_period_start,
           voting_period_end,
           visibility_group_id,
           chat_group_id,
           chat_enabled,
           chat_slow_mode_cooldown_ms,
           chat_links_disabled,
           participation_group_id,
           participation_max_applications_per_participant,
           participation_required_metadata,
           participation_required_media,
           submission_type,
           identity_submission_strategy,
           identity_submission_duplicates,
           participation_period_start,
           participation_period_end,
           participation_signature_required,
           participation_terms,
           admin_drop_deletion_enabled,
           type,
           winning_min_threshold,
           winning_max_threshold,
           winning_threshold_min_duration_ms,
           max_winners,
           max_votes_per_identity_to_drop,
           time_lock_ms,
           decisions_strategy,
           next_decision_time,
           forbid_negative_votes,
           is_direct_message${wave.serial_no !== null ? ', serial_no' : ''})
          values (:id,
                  :name,
                  :parent_wave_id,
                  :picture,
                  :description_drop_id,
                  :created_at,
                  :updated_at,
                  :created_by,
                  :voting_group_id,
                  :admin_group_id,
                  :voting_credit_type,
                  :voting_credit_scope,
                  :voting_credit_category,
                  :voting_credit_creditor,
                  :voting_signature_required,
                  :voting_period_start,
                  :voting_period_end,
                  :visibility_group_id,
                  :chat_group_id,
                  :chat_enabled,
                  :chat_slow_mode_cooldown_ms,
                  :chat_links_disabled,
                  :participation_group_id,
                  :participation_max_applications_per_participant,
                  :participation_required_metadata,
                  :participation_required_media,
                  :submission_type,
                  :identity_submission_strategy,
                  :identity_submission_duplicates,
                  :participation_period_start,
                  :participation_period_end,
                  :participation_signature_required,
                  :participation_terms,
                  :admin_drop_deletion_enabled,
                  :type,
                  :winning_min_threshold,
                  :winning_max_threshold,
                  :winning_threshold_min_duration_ms,
                  :max_winners,
                  :max_votes_per_identity_to_drop,
                  :time_lock_ms,
                  :decisions_strategy,
                  :next_decision_time,
                  :forbid_negative_votes,
                  :is_direct_message${wave.serial_no !== null ? ', :serial_no' : ''})`,
        params,
        { wrappedConnection: connection }
      )
      .then(
        async () => wave.serial_no ?? (await this.getLastInsertId(connection))
      );
    await this.db.execute(
      `insert into ${WAVES_ARCHIVE_TABLE}
                           (
                            archival_entry_created_at,
                            id,
                            name,
                            parent_wave_id,
                            picture,
                            description_drop_id,
                            created_at,
                            updated_at,
                            created_by,
                            voting_group_id,
                            admin_group_id,
                            voting_credit_type,
                            voting_credit_scope,
                            voting_credit_category,
                            voting_credit_creditor,
                            voting_signature_required,
                            voting_period_start,
                            voting_period_end,
                            visibility_group_id,
                            chat_group_id,
                            chat_enabled,
                            chat_slow_mode_cooldown_ms,
                            chat_links_disabled,
                            participation_group_id,
                            participation_max_applications_per_participant,
                            participation_required_metadata,
                            participation_required_media,
                            submission_type,
                            identity_submission_strategy,
                            identity_submission_duplicates,
                            participation_period_start,
                            participation_period_end,
                            participation_terms,
                            admin_drop_deletion_enabled,
                            participation_signature_required,
                            type,
                            winning_min_threshold,
                            winning_max_threshold,
                            winning_threshold_min_duration_ms,
                            max_winners,
                            max_votes_per_identity_to_drop,
                            time_lock_ms,
                            decisions_strategy,
                            serial_no,
                            forbid_negative_votes,
                            is_direct_message
                           )
                           values (
                                   :now,
                                   :id,
                                   :name,
                                   :parent_wave_id,
                                   :picture,
                                   :description_drop_id,
                                   :created_at,
                                   :updated_at,
                                   :created_by,
                                   :voting_group_id,
                                   :admin_group_id,
                                   :voting_credit_type,
                                   :voting_credit_scope,
                                   :voting_credit_category,
                                   :voting_credit_creditor,
                                   :voting_signature_required,
                                   :voting_period_start,
                                   :voting_period_end,
                                   :visibility_group_id,
                                   :chat_group_id,
                                   :chat_enabled,
                                   :chat_slow_mode_cooldown_ms,
                                   :chat_links_disabled,
                                   :participation_group_id,
                                   :participation_max_applications_per_participant,
                                   :participation_required_metadata,
                                   :participation_required_media,
                                   :submission_type,
                                   :identity_submission_strategy,
                                   :identity_submission_duplicates,
                                   :participation_period_start,
                                   :participation_period_end,
                                   :participation_terms,
                                   :admin_drop_deletion_enabled,
                                   :participation_signature_required,
                                   :type,
                                   :winning_min_threshold,
                                   :winning_max_threshold,
                                   :winning_threshold_min_duration_ms,
                                   :max_winners,
                                   :max_votes_per_identity_to_drop,
                                   :time_lock_ms,
                                   :decisions_strategy,
                                   :serial_no,
                                   :forbid_negative_votes,
                           :is_direct_message
                           )`,
      { ...params, serial_no: serial, now: Time.currentMillis() },
      { wrappedConnection: connection }
    );
    const waveArchiveId = await this.getLastInsertId(connection);
    await this.insertWaveVotingCreditNfts(
      {
        waveId: wave.id,
        creditNfts: wave.voting_credit_nfts
      },
      ctx
    );
    await this.insertWaveVotingCreditNftArchives(
      {
        waveId: wave.id,
        waveArchiveId,
        creditNfts: wave.voting_credit_nfts
      },
      ctx
    );
    ctx.timer?.stop('waveApiDb->insertWave');
  }

  private async insertWaveVotingCreditNfts(
    {
      waveId,
      creditNfts
    }: {
      waveId: string;
      creditNfts: readonly WaveVotingCreditNft[];
    },
    ctx: RequestContext
  ): Promise<void> {
    const timerKey = `${this.constructor.name}->insertWaveVotingCreditNfts`;
    ctx.timer?.start(timerKey);
    try {
      const normalizedCreditNfts = normalizeWaveVotingCreditNfts(creditNfts);
      if (!normalizedCreditNfts.length) {
        return;
      }
      await this.db.bulkInsert(
        WAVE_VOTING_CREDIT_NFTS_TABLE,
        normalizedCreditNfts.map((creditNft) => ({
          wave_id: waveId,
          contract: creditNft.contract,
          token_id: creditNft.tokenId
        })),
        ['wave_id', 'contract', 'token_id'],
        ctx
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  private async insertWaveVotingCreditNftArchives(
    {
      waveId,
      waveArchiveId,
      creditNfts
    }: {
      waveId: string;
      waveArchiveId: number;
      creditNfts: readonly WaveVotingCreditNft[];
    },
    ctx: RequestContext
  ): Promise<void> {
    const timerKey = `${this.constructor.name}->insertWaveVotingCreditNftArchives`;
    ctx.timer?.start(timerKey);
    try {
      const normalizedCreditNfts = normalizeWaveVotingCreditNfts(creditNfts);
      if (!normalizedCreditNfts.length) {
        return;
      }
      await this.db.bulkInsert(
        WAVE_VOTING_CREDIT_NFTS_ARCHIVE_TABLE,
        normalizedCreditNfts.map((creditNft) => ({
          wave_archive_id: waveArchiveId,
          wave_id: waveId,
          contract: creditNft.contract,
          token_id: creditNft.tokenId
        })),
        ['wave_archive_id', 'wave_id', 'contract', 'token_id'],
        ctx
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async findWaveVotingCreditNftsByWaveIds(
    waveIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, WaveVotingCreditNft[]>> {
    if (!waveIds.length) {
      return {};
    }
    return this.db
      .execute<WaveVotingCreditNftRow>(
        `
          SELECT wave_id, contract, token_id
          FROM ${WAVE_VOTING_CREDIT_NFTS_TABLE}
          WHERE wave_id IN (:waveIds)
          ORDER BY contract, token_id
        `,
        { waveIds },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((rows) =>
        rows.reduce(
          (acc, row) => {
            const creditNfts = acc[row.wave_id] ?? [];
            creditNfts.push({
              contract: row.contract,
              tokenId: Number(row.token_id)
            });
            acc[row.wave_id] = creditNfts;
            return acc;
          },
          {} as Record<string, WaveVotingCreditNft[]>
        )
      );
  }

  public async findExistingCardSetCreditNftKeys(
    creditNfts: readonly WaveVotingCreditNft[],
    ctx: RequestContext
  ): Promise<Set<string>> {
    const timerKey = `${this.constructor.name}->findExistingCardSetCreditNftKeys`;
    ctx.timer?.start(timerKey);
    try {
      const queryOptions = ctx.connection
        ? { wrappedConnection: ctx.connection }
        : undefined;
      const groupedCreditNfts = groupWaveVotingCreditNftsByContract(creditNfts);
      if (!groupedCreditNfts.length) {
        return new Set<string>();
      }
      const queryParams: Record<string, string | readonly number[]> = {};
      const whereClauses = groupedCreditNfts.map(
        ({ contract, tokenIds }, index) => {
          const contractParam = `contract${index}`;
          const tokenIdsParam = `tokenIds${index}`;
          queryParams[contractParam] = contract;
          queryParams[tokenIdsParam] = tokenIds;
          return `(contract = :${contractParam} AND id IN (:${tokenIdsParam}))`;
        }
      );
      const rows = await this.db.execute<{
        contract: string;
        token_id: number;
      }>(
        `
          SELECT contract, id AS token_id
          FROM ${NFTS_TABLE}
          WHERE ${whereClauses.join(' OR ')}
        `,
        queryParams,
        queryOptions
      );
      return new Set(
        rows.map((row) =>
          waveVotingCreditNftKey(row.contract, Number(row.token_id))
        )
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  async searchWaves(
    searchParams: SearchWavesParams,
    groupsUserIsEligibleFor: string[],
    ctx: RequestContext
  ): Promise<WaveEntity[]> {
    if (
      searchParams.group_id &&
      !groupsUserIsEligibleFor.includes(searchParams.group_id)
    ) {
      return [];
    }
    const sqlAndParams = await userGroupsService.getSqlAndParamsByGroupId(
      searchParams.group_id ?? null,
      ctx
    );
    if (!sqlAndParams) {
      return [];
    }
    const serialNoLessThan =
      searchParams.serial_no_less_than ?? Number.MAX_SAFE_INTEGER;
    const offset = searchParams.offset ?? 0;
    const sql = `${sqlAndParams.sql} select w.* from ${WAVES_TABLE} w
           left join ${WAVES_TABLE} parent on parent.id = w.parent_wave_id
	         join ${
             UserGroupsService.GENERATED_VIEW
           } cm on cm.profile_id = w.created_by
         where ${searchParams.author ? ` w.created_by = :author and ` : ``} ${
           searchParams.name ? ` w.name like :name and ` : ``
         } ${
           searchParams.direct_message !== undefined
             ? ` w.is_direct_message = :direct_message and `
             : ``
         }${this.getWaveAndParentVisibilityFilter(
           'w',
           'parent',
           groupsUserIsEligibleFor,
           'groupsUserIsEligibleFor'
         )} and w.serial_no < :serialNoLessThan order by w.serial_no desc limit ${
           searchParams.limit
         } offset :offset`;
    const params: Record<string, any> = {
      ...sqlAndParams.params,
      groupsUserIsEligibleFor,
      serialNoLessThan,
      offset,
      name: searchParams.name ? `%${searchParams.name}%` : undefined,
      author: searchParams.author,
      direct_message: searchParams.direct_message
    };
    return this.db
      .execute<
        Omit<
          WaveEntity,
          | 'participation_required_media'
          | 'participation_required_metadata'
          | 'decisions_strategy'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
          decisions_strategy: string;
        }
      >(sql, params)
      .then((it) =>
        it.map((wave) => ({
          ...wave,
          participation_required_media: JSON.parse(
            wave.participation_required_media
          ),
          participation_required_metadata: JSON.parse(
            wave.participation_required_metadata
          ),
          decisions_strategy: wave.decisions_strategy
            ? JSON.parse(wave.decisions_strategy)
            : null
        }))
      );
  }

  async getWavesByDropIds(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, WaveEntityWithLastDropTime>> {
    if (dropIds.length === 0) {
      return {};
    }
    return this.db
      .execute<
        RawWaveEntityWithLastDropTime & {
          drop_id: string;
        }
      >(
        `
        select 
          d.id as drop_id, 
          w.*,
          COALESCE(wm.latest_drop_timestamp, 0) as last_drop_time
        from ${DROPS_TABLE} d
        join ${WAVES_TABLE} w on w.id = d.wave_id
        left join ${WAVE_METRICS_TABLE} wm on wm.wave_id = w.id
        where d.id in (:dropIds)
        `,
        {
          dropIds
        },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it) =>
        it.reduce<Record<string, WaveEntityWithLastDropTime>>(
          (acc, wave) => {
            acc[wave.drop_id] = this.parseWaveEntityWithLastDropTime(wave);
            delete (acc[wave.drop_id] as any).drop_id;
            return acc;
          },
          {} as Record<string, WaveEntityWithLastDropTime>
        )
      );
  }

  async findVisibleParentWavesByChildWaveIds(
    childWaveIds: string[],
    groupIdsUserIsEligibleFor: string[],
    ctx: RequestContext
  ): Promise<Record<string, WaveEntity>> {
    if (!childWaveIds.length) {
      return {};
    }
    const timerKey = `${this.constructor.name}->findVisibleParentWavesByChildWaveIds`;
    ctx.timer?.start(timerKey);
    try {
      const rows = await this.db.execute<
        RawWaveEntity & { child_wave_id: string }
      >(
        `
          select child.id as child_wave_id, parent.*
          from ${WAVES_TABLE} child
          join ${WAVES_TABLE} parent on parent.id = child.parent_wave_id
          where child.id in (:childWaveIds)
            and parent.parent_wave_id is null
            and ${this.getWaveVisibilityFilter(
              'parent',
              groupIdsUserIsEligibleFor,
              'groupIdsUserIsEligibleFor'
            )}
        `,
        { childWaveIds, groupIdsUserIsEligibleFor },
        { wrappedConnection: ctx.connection }
      );
      return rows.reduce(
        (acc, row) => {
          const { child_wave_id, ...parent } = row;
          acc[child_wave_id] = this.parseWaveEntity(parent);
          return acc;
        },
        {} as Record<string, WaveEntity>
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  async findWaveIdsWithVisibleSubwaves(
    waveIds: string[],
    groupIdsUserIsEligibleFor: string[],
    ctx: RequestContext
  ): Promise<Set<string>> {
    if (!waveIds.length) {
      return new Set<string>();
    }
    const timerKey = `${this.constructor.name}->findWaveIdsWithVisibleSubwaves`;
    ctx.timer?.start(timerKey);
    try {
      const rows = await this.db.execute<{ wave_id: string }>(
        `
          select distinct w.parent_wave_id as wave_id
          from ${WAVES_TABLE} w
          join ${WAVES_TABLE} parent
            on parent.id = w.parent_wave_id
           and parent.parent_wave_id is null
          where w.parent_wave_id in (:waveIds)
            and ${this.getWaveVisibilityFilter(
              'w',
              groupIdsUserIsEligibleFor,
              'groupIdsUserIsEligibleFor'
            )}
        `,
        { waveIds, groupIdsUserIsEligibleFor },
        { wrappedConnection: ctx.connection }
      );
      return new Set(rows.map((row) => row.wave_id));
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  async findFollowedSubwaveOverviewContextsByParentWaveId(
    {
      identityId,
      parentWaveIds,
      eligibleGroups
    }: {
      identityId: string;
      parentWaveIds: string[];
      eligibleGroups: string[];
    },
    ctx: RequestContext
  ): Promise<Record<string, FollowedSubwaveOverviewContext>> {
    if (!parentWaveIds.length) {
      return {};
    }
    const timerKey = `${this.constructor.name}->findFollowedSubwaveOverviewContextsByParentWaveId`;
    ctx.timer?.start(timerKey);
    try {
      const followedSubwaveActivityByParentWaveId =
        await withFollowedSubwaveOverviewContextCache({
          identityId,
          parentWaveIds,
          eligibleGroups,
          cacheable: ctx.connection === undefined,
          getValue: async () => {
            const activityRows =
              await this.db.execute<FollowedSubwaveActivityRow>(
                `
                  ${this.getFollowedSubwaveActivitySelect({
                    groupIds: eligibleGroups,
                    identityParamName: 'identityId',
                    eligibleGroupsParamName: 'eligibleGroups',
                    parentWaveIdsParamName: 'parentWaveIds'
                  })}
                `,
                {
                  identityId,
                  parentWaveIds,
                  eligibleGroups,
                  wave_target_type: ActivityEventTargetType.WAVE,
                  drop_created_action: ActivityEventAction.DROP_CREATED
                },
                { wrappedConnection: ctx.connection }
              );

            return activityRows.reduce(
              (acc, row) => {
                acc[row.parent_wave_id] = {
                  followed_subwaves_count: Number(row.followed_subwaves_count),
                  latest_followed_subwave_activity_timestamp:
                    this.toActivityTimestamp(
                      row.latest_followed_subwave_activity_timestamp
                    )
                };
                return acc;
              },
              {} as Record<
                string,
                {
                  followed_subwaves_count: number;
                  latest_followed_subwave_activity_timestamp: number | null;
                }
              >
            );
          }
        });

      const unreadRows = await withInFlightFollowedSubwaveUnreadRead({
        identityId,
        parentWaveIds,
        eligibleGroups,
        getValue: async () => {
          // Keep hidden unread live so wave-reader-metric invalidations are
          // visible immediately; only coalesce identical concurrent reads.
          return this.db.execute<HiddenFollowedSubwaveUnreadRow>(
            `
              select
                child.parent_wave_id,
                count(d.id) as hidden_followed_subwave_unread_drops,
                min(d.serial_no) as first_hidden_followed_subwave_unread_drop_serial_no
              from ${WAVES_TABLE} child
              join ${WAVES_TABLE} parent
                on parent.id = child.parent_wave_id
               and parent.parent_wave_id is null
              left join ${WAVE_READER_METRICS_TABLE} parent_reader
                on parent_reader.wave_id = parent.id
               and parent_reader.reader_id = :identityId
              join ${IDENTITY_SUBSCRIPTIONS_TABLE} child_follow
                on child_follow.subscriber_id = :identityId
               and child_follow.target_id = child.id
               and child_follow.target_type = :waveTargetType
               and child_follow.target_action = :dropCreatedAction
              join ${WAVE_READER_METRICS_TABLE} child_reader
                on child_reader.wave_id = child.id
               and child_reader.reader_id = :identityId
               and child_reader.latest_read_timestamp is not null
               and coalesce(child_reader.muted, false) = false
              join ${DROPS_TABLE} d
                on d.wave_id = child.id
               and d.created_at > child_reader.latest_read_timestamp
              where child.parent_wave_id in (:parentWaveIds)
                and coalesce(parent_reader.muted, false) = false
                and ${this.getWaveVisibilityFilter(
                  'child',
                  eligibleGroups,
                  'eligibleGroups'
                )}
                and ${this.getWaveVisibilityFilter(
                  'parent',
                  eligibleGroups,
                  'eligibleGroups'
                )}
              group by child.parent_wave_id
            `,
            {
              identityId,
              parentWaveIds,
              eligibleGroups,
              waveTargetType: ActivityEventTargetType.WAVE,
              dropCreatedAction: ActivityEventAction.DROP_CREATED
            },
            { wrappedConnection: ctx.connection }
          );
        }
      });

      const result = Object.entries(
        followedSubwaveActivityByParentWaveId
      ).reduce(
        (acc, [parentWaveId, activity]) => {
          acc[parentWaveId] = {
            ...activity,
            hidden_followed_subwave_unread_drops: 0,
            first_hidden_followed_subwave_unread_drop_serial_no: null
          };
          return acc;
        },
        {} as Record<string, FollowedSubwaveOverviewContext>
      );

      for (const row of unreadRows) {
        const existing = result[row.parent_wave_id];
        if (!existing) {
          continue;
        }
        result[row.parent_wave_id] = {
          ...existing,
          hidden_followed_subwave_unread_drops: Number(
            row.hidden_followed_subwave_unread_drops
          ),
          first_hidden_followed_subwave_unread_drop_serial_no:
            this.toNullableNumber(
              row.first_hidden_followed_subwave_unread_drop_serial_no
            )
        };
      }

      return result;
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  async findSubwaves(
    {
      parentWaveId,
      eligibleGroups,
      limit,
      offset,
      sort
    }: {
      parentWaveId: string;
      eligibleGroups: string[];
      limit: number;
      offset: number;
      sort: WaveSubwavesSort;
    },
    ctx: RequestContext
  ): Promise<WaveEntity[]> {
    const timerKey = `${this.constructor.name}->findSubwaves`;
    ctx.timer?.start(timerKey);
    try {
      const orderBy =
        sort === WaveSubwavesSort.CREATED_AT
          ? `w.created_at desc, w.id asc`
          : `lower(w.name) asc, w.name asc, w.id asc`;
      const rows = await this.db.execute<RawWaveEntity>(
        `
          select w.*
          from ${WAVES_TABLE} w
          left join ${WAVES_TABLE} parent on parent.id = w.parent_wave_id
          where w.parent_wave_id = :parentWaveId
            and ${this.getWaveAndParentVisibilityFilter(
              'w',
              'parent',
              eligibleGroups,
              'eligibleGroups'
            )}
          order by ${orderBy}
          limit :limit offset :offset
        `,
        { parentWaveId, eligibleGroups, limit, offset },
        { wrappedConnection: ctx.connection }
      );
      return rows.map((row) => this.parseWaveEntity(row));
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  async findSubwaveIdsByParentWaveId(
    parentWaveId: string,
    ctx: RequestContext
  ): Promise<string[]> {
    const timerKey = `${this.constructor.name}->findSubwaveIdsByParentWaveId`;
    ctx.timer?.start(timerKey);
    try {
      const rows = await this.db.execute<{ id: string }>(
        `
          select id
          from ${WAVES_TABLE}
          where parent_wave_id = :parentWaveId
          order by id asc
        `,
        { parentWaveId },
        { wrappedConnection: ctx.connection }
      );
      return rows.map((row) => row.id);
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  async getWavesContributorsOverviews(
    waveIds: string[],
    { connection, timer }: RequestContext
  ): Promise<
    Record<string, { contributor_identity: string; contributor_pfp: string }[]>
  > {
    if (waveIds.length === 0) {
      return {};
    }
    timer?.start('wavesApiDb->getWavesContributorsOverviews');
    const result = await this.db
      .execute<{
        wave_id: string;
        contributor_identity: string;
        contributor_pfp: string;
      }>(
        `WITH distinct_authors AS (
            SELECT DISTINCT wave_id, author_id
            FROM drops
            WHERE wave_id IN (:waveIds)),
              authors_with_levels AS (
                  SELECT
                      da.wave_id,
                      i.profile_id,
                      i.primary_address,
                      i.pfp,
                      i.level_raw
                  FROM distinct_authors da
                           JOIN identities i
                                ON i.profile_id = da.author_id
                  WHERE i.pfp IS NOT NULL
              ),
              ranked AS (
                  SELECT
                      wave_id,
                      pfp                  AS contributor_pfp,
                      primary_address      AS contributor_identity,
                      ROW_NUMBER() OVER (PARTITION BY wave_id ORDER BY level_raw DESC) AS rn
                  FROM authors_with_levels
              )
         SELECT wave_id, contributor_pfp, contributor_identity
         FROM ranked
         WHERE rn <= 5
         ORDER BY wave_id, rn`,
        {
          waveIds
        },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it) =>
        it.reduce<
          Record<
            string,
            { contributor_identity: string; contributor_pfp: string }[]
          >
        >(
          (acc, wave) => {
            if (!acc[wave.wave_id]) {
              acc[wave.wave_id] = [];
            }
            acc[wave.wave_id].push({
              contributor_identity: wave.contributor_identity,
              contributor_pfp: wave.contributor_pfp
            });
            return acc;
          },
          {} as Record<
            string,
            { contributor_identity: string; contributor_pfp: string }[]
          >
        )
      );
    timer?.stop('wavesApiDb->getWavesContributorsOverviews');
    return result;
  }

  async findMostSubscribedWaves({
    only_waves_followed_by_authenticated_user,
    authenticated_user_id,
    eligibleGroups,
    limit,
    offset,
    direct_message,
    pinned
  }: {
    only_waves_followed_by_authenticated_user: boolean;
    authenticated_user_id: string | null;
    eligibleGroups: string[];
    limit: number;
    offset: number;
    direct_message?: boolean;
    pinned: ApiWavesPinFilter | null;
  }): Promise<WaveEntity[]> {
    return this.db
      .execute<
        Omit<
          WaveEntity,
          | 'participation_required_media'
          | 'participation_required_metadata'
          | 'decisions_strategy'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
          decisions_strategy: string;
        }
      >(
        `
      with subscription_counts as (
        select target_id as wave_id, count(*) as subscribers_count
        from ${IDENTITY_SUBSCRIPTIONS_TABLE}
        where target_type = 'WAVE'
        group by target_id
      ),
      sorted as (
        select w.id as wave_id, sc.subscribers_count
        from subscription_counts sc
          join ${WAVES_TABLE} w on w.id = sc.wave_id
          ${
            pinned === ApiWavesPinFilter.Pinned && authenticated_user_id
              ? ` join ${PINNED_WAVES_TABLE} pw on pw.wave_id = w.id and pw.profile_id = :authenticated_user_id `
              : ``
          }
          ${
            pinned === ApiWavesPinFilter.NotPinned && authenticated_user_id
              ? ` left join ${PINNED_WAVES_TABLE} pw on pw.wave_id = w.id and pw.profile_id = :authenticated_user_id `
              : ``
          }
          ${
            only_waves_followed_by_authenticated_user
              ? `join ${IDENTITY_SUBSCRIPTIONS_TABLE} f on f.target_type = 'WAVE' and f.target_action = 'DROP_CREATED' and f.target_id = w.id`
              : ``
          }
        where ${pinned === ApiWavesPinFilter.NotPinned && authenticated_user_id ? ` pw.profile_id is null and ` : ``} ${
          only_waves_followed_by_authenticated_user
            ? `f.subscriber_id = :authenticated_user_id and`
            : ``
        }${
          direct_message !== undefined
            ? ` w.is_direct_message = :direct_message and `
            : ``
        } w.parent_wave_id is null and (w.visibility_group_id is null ${
          eligibleGroups.length
            ? `or w.visibility_group_id in (:eligibleGroups)`
            : ``
        })
        order by sc.subscribers_count desc, sc.wave_id desc
        limit :limit offset :offset
      ), wids as (
      select w.id
      from sorted s
        join ${WAVES_TABLE} w on w.id = s.wave_id
        ${
          pinned === ApiWavesPinFilter.Pinned && authenticated_user_id
            ? ` join ${PINNED_WAVES_TABLE} pw on pw.wave_id = w.id and pw.profile_id = :authenticated_user_id `
            : ``
        }
        ${
          pinned === ApiWavesPinFilter.NotPinned && authenticated_user_id
            ? ` left join ${PINNED_WAVES_TABLE} pw on pw.wave_id = w.id and pw.profile_id = :authenticated_user_id `
            : ``
        }
        ${
          only_waves_followed_by_authenticated_user
            ? `join ${IDENTITY_SUBSCRIPTIONS_TABLE} f on f.target_type = 'WAVE' and f.target_action = 'DROP_CREATED' and f.target_id = w.id`
            : ``
        }
      where ${pinned === ApiWavesPinFilter.NotPinned && authenticated_user_id ? ` pw.profile_id is null and ` : ``} ${
        only_waves_followed_by_authenticated_user
          ? `f.subscriber_id = :authenticated_user_id and`
          : ``
      }${
        direct_message !== undefined
          ? ` w.is_direct_message = :direct_message and `
          : ``
      } w.parent_wave_id is null and (w.visibility_group_id is null ${
        eligibleGroups.length
          ? `or w.visibility_group_id in (:eligibleGroups)`
          : ``
      })
      order by s.subscribers_count desc, s.wave_id desc
      limit :limit offset :offset) select w.* from wids join ${WAVES_TABLE} w on w.id = wids.id
        `,
        {
          limit,
          offset,
          eligibleGroups,
          authenticated_user_id,
          direct_message
        }
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          participation_required_media: JSON.parse(
            it.participation_required_media
          ),
          participation_required_metadata: JSON.parse(
            it.participation_required_metadata
          ),
          decisions_strategy: it.decisions_strategy
            ? JSON.parse(it.decisions_strategy)
            : null
        }))
      );
  }

  async findFavouriteWavesOfIdentity(
    {
      identityId,
      eligibleGroups,
      limit,
      offset
    }: {
      identityId: string;
      eligibleGroups: string[];
      limit: number;
      offset: number;
    },
    ctx: RequestContext
  ): Promise<WaveEntity[]> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->findFavouriteWavesOfIdentity`
      );
      return await this.db
        .execute<RawWaveEntity>(
          `
            select w.*
            from ${WAVE_DROPPER_METRICS_TABLE} wdm
              join ${WAVES_TABLE} w on w.id = wdm.wave_id
            where wdm.dropper_id = :identityId
              and wdm.drops_count > 0
              and w.is_direct_message = false
              and w.parent_wave_id is null
              and (
                w.visibility_group_id is null
                ${
                  eligibleGroups.length
                    ? `or w.visibility_group_id in (:eligibleGroups)`
                    : ``
                }
              )
            order by
              wdm.drops_count desc,
              wdm.latest_drop_timestamp desc,
              w.id desc
            limit :limit offset :offset
          `,
          {
            identityId,
            eligibleGroups,
            limit,
            offset
          },
          ctx.connection ? { wrappedConnection: ctx.connection } : undefined
        )
        .then((result) => result.map((it) => this.parseWaveEntity(it)));
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findFavouriteWavesOfIdentity`);
    }
  }

  async findWavesMetricsByWaveIds(
    waveIds: string[],
    { connection, timer }: RequestContext
  ): Promise<Record<string, WaveMetricEntity>> {
    if (!waveIds.length) {
      return {};
    }
    timer?.start('wavesApiDb->findWavesMetricsByWaveIds');
    const result = await this.db
      .execute<WaveMetricEntity>(
        `select * from ${WAVE_METRICS_TABLE} where wave_id in (:waveIds)`,
        { waveIds },
        { wrappedConnection: connection }
      )
      .then((results) => {
        const existingMetricsByWaveId = results.reduce(
          (acc, metric) => {
            acc[metric.wave_id] = metric;
            return acc;
          },
          {} as Record<string, WaveMetricEntity>
        );
        return waveIds.reduce(
          (acc, waveId) => {
            acc[waveId] = existingMetricsByWaveId[waveId] ?? {
              wave_id: waveId,
              subscribers_count: 0,
              drops_count: 0,
              participatory_drops_count: 0,
              latest_drop_timestamp: 0,
              wave_rep_total: 0,
              wave_rep_positive: 0,
              wave_rep_negative: 0,
              wave_rep_contributor_count: 0,
              wave_rep_positive_contributor_count: 0,
              wave_rep_negative_contributor_count: 0,
              wave_score_version: 'wave-score-v1',
              wave_visibility_tier: 'EXPLORATION_NEUTRAL',
              wave_visibility_rank: 2,
              wave_quality_score: 0,
              wave_hotness_score: 0,
              wave_rep_sort_score: 50,
              wave_visibility_score: 0,
              wave_creator_score: 0,
              wave_level_weighted_participation_score: 0,
              wave_trusted_diversity_score: 0,
              wave_rep_component_score: 50,
              wave_trusted_subscription_score: 0,
              wave_recent_trusted_activity_score: 0,
              wave_single_actor_penalty: 0,
              wave_low_trust_flood_penalty: 0,
              wave_cross_post_pressure: 0,
              wave_cross_post_penalty: 0,
              wave_negative_rep_penalty: 0,
              wave_safety_multiplier: 1,
              wave_score_calculated_at: 0
            };
            return acc;
          },
          {} as Record<string, WaveMetricEntity>
        );
      });
    timer?.stop('wavesApiDb->findWavesMetricsByWaveIds');
    return result;
  }

  async findWaveDropperMetricsByWaveIds(
    params: { dropperId: string; waveIds: string[] },
    { connection, timer }: RequestContext
  ): Promise<Record<string, WaveDropperMetricEntity>> {
    if (!params.waveIds.length) {
      return {};
    }
    timer?.start('wavesApiDb->findWaveDropperMetricsByWaveIds');
    const result = await this.db
      .execute<WaveDropperMetricEntity>(
        `select * from ${WAVE_DROPPER_METRICS_TABLE} where wave_id in (:waveIds) and dropper_id = :dropperId`,
        params,
        { wrappedConnection: connection }
      )
      .then((results) =>
        params.waveIds.reduce(
          (acc, waveId) => {
            acc[waveId] = results.find((it) => it.wave_id === waveId) ?? {
              wave_id: waveId,
              dropper_id: params.dropperId,
              drops_count: 0,
              participatory_drops_count: 0,
              latest_drop_timestamp: 0
            };
            return acc;
          },
          {} as Record<string, WaveDropperMetricEntity>
        )
      );
    timer?.stop('wavesApiDb->findWaveDropperMetricsByWaveIds');
    return result;
  }

  async findWaveChatDropCooldownsByWaveIds(
    params: { profileId: string; waveIds: string[] },
    ctx: RequestContext
  ): Promise<Record<string, WaveChatDropCooldownEntity>> {
    if (!params.waveIds.length) {
      return {};
    }
    const timerKey = `${this.constructor.name}->findWaveChatDropCooldownsByWaveIds`;
    ctx.timer?.start(timerKey);
    try {
      const queryOptions = ctx.connection
        ? { wrappedConnection: ctx.connection }
        : undefined;
      const now = Time.currentMillis();
      const rows = await this.db.execute<WaveChatDropCooldownPolicyRow>(
        `select w.id as wave_id,
                w.chat_slow_mode_cooldown_ms,
                max(d.created_at) as latest_drop_timestamp,
                c.next_drop_timestamp as stored_next_drop_timestamp,
                c.created_at as stored_created_at,
                c.updated_at as stored_updated_at
         from ${WAVES_TABLE} w
         left join ${DROPS_TABLE} d
           on d.wave_id = w.id
          and d.author_id = :profileId
          and d.drop_type = :dropType
         left join ${WAVE_CHAT_DROP_COOLDOWNS_TABLE} c
           on c.wave_id = w.id
          and c.profile_id = :profileId
         where w.id in (:waveIds)
         group by w.id,
                  w.chat_slow_mode_cooldown_ms,
                  c.next_drop_timestamp,
                  c.created_at,
                  c.updated_at`,
        {
          waveIds: Array.from(new Set(params.waveIds)),
          profileId: params.profileId,
          dropType: DropType.CHAT
        },
        queryOptions
      );
      const result: Record<string, WaveChatDropCooldownEntity> = {};
      const updatePromises: Promise<unknown>[] = [];
      for (const row of rows) {
        const policy = this.resolveWaveChatDropCooldownPolicy(row);
        const storedNextDropTimestamp = this.toNullableNumber(
          row.stored_next_drop_timestamp
        );
        const hasStoredRow = storedNextDropTimestamp !== null;
        const storedRowDrifted =
          hasStoredRow && storedNextDropTimestamp !== policy.nextDropTimestamp;
        if (storedRowDrifted) {
          updatePromises.push(
            this.db.execute(
              `update ${WAVE_CHAT_DROP_COOLDOWNS_TABLE}
               set next_drop_timestamp = :nextDropTimestamp,
                   updated_at = :now
               where wave_id = :waveId and profile_id = :profileId`,
              {
                waveId: row.wave_id,
                profileId: params.profileId,
                nextDropTimestamp: policy.nextDropTimestamp,
                now
              },
              queryOptions
            )
          );
        }
        if (!hasStoredRow && policy.nextDropTimestamp <= now) {
          continue;
        }
        result[row.wave_id] = {
          wave_id: row.wave_id,
          profile_id: params.profileId,
          next_drop_timestamp: policy.nextDropTimestamp,
          created_at:
            this.toNullableNumber(row.stored_created_at) ??
            policy.latestDropTimestamp ??
            now,
          updated_at: storedRowDrifted
            ? now
            : (this.toNullableNumber(row.stored_updated_at) ??
              policy.latestDropTimestamp ??
              now)
        };
      }
      await Promise.all(updatePromises);

      return result;
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  async reserveWaveChatDropCooldown(
    params: {
      waveId: string;
      profileId: string;
      now: number;
      cooldownMs: number;
    },
    ctx: RequestContext
  ): Promise<number | null> {
    const connection = ctx.connection;
    if (!connection) {
      throw new Error('reserveWaveChatDropCooldown requires a connection');
    }
    const timerKey = `${this.constructor.name}->reserveWaveChatDropCooldown`;
    ctx.timer?.start(timerKey);
    try {
      await this.db.execute(
        `insert ignore into ${WAVE_CHAT_DROP_COOLDOWNS_TABLE}
         (wave_id, profile_id, next_drop_timestamp, created_at, updated_at)
         values (:waveId, :profileId, 0, :now, :now)`,
        params,
        { wrappedConnection: connection }
      );
      const existing = await this.db.oneOrNull<WaveChatDropCooldownEntity>(
        `select * from ${WAVE_CHAT_DROP_COOLDOWNS_TABLE}
         where wave_id = :waveId and profile_id = :profileId
         for update`,
        params,
        { wrappedConnection: connection }
      );
      if (!existing) {
        throw new Error('Failed to lock wave chat drop cooldown row');
      }
      const wavePolicy = await this.db.oneOrNull<{
        chat_slow_mode_cooldown_ms: number | null;
      }>(
        `select chat_slow_mode_cooldown_ms
         from ${WAVES_TABLE}
         where id = :waveId
         for update`,
        params,
        { wrappedConnection: connection }
      );
      if (!wavePolicy) {
        throw new Error(`Wave ${params.waveId} not found`);
      }
      const latestDrop = await this.db.oneOrNull<{
        latest_drop_timestamp: number | null;
      }>(
        `select created_at as latest_drop_timestamp
         from ${DROPS_TABLE}
         where wave_id = :waveId
           and author_id = :profileId
           and drop_type = :dropType
         order by created_at desc
         limit 1
         for update`,
        { ...params, dropType: DropType.CHAT },
        { wrappedConnection: connection }
      );
      const policy = this.resolveWaveChatDropCooldownPolicy({
        chat_slow_mode_cooldown_ms: wavePolicy.chat_slow_mode_cooldown_ms,
        latest_drop_timestamp: latestDrop?.latest_drop_timestamp ?? null
      });
      const existingNextDropTimestamp = Number(existing.next_drop_timestamp);
      const blockedUntil = policy.nextDropTimestamp;
      let nextDropTimestamp: number;
      if (blockedUntil > params.now) {
        nextDropTimestamp = blockedUntil;
      } else if (policy.cooldownMs !== null && policy.cooldownMs > 0) {
        nextDropTimestamp = params.now + policy.cooldownMs;
      } else {
        nextDropTimestamp = 0;
      }
      if (existingNextDropTimestamp !== nextDropTimestamp) {
        await this.db.execute(
          `update ${WAVE_CHAT_DROP_COOLDOWNS_TABLE}
           set next_drop_timestamp = :nextDropTimestamp,
               updated_at = :now
           where wave_id = :waveId and profile_id = :profileId`,
          { ...params, nextDropTimestamp },
          { wrappedConnection: connection }
        );
      }
      if (blockedUntil > params.now) {
        return blockedUntil;
      }
      return null;
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  async findById(
    wave_id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<WaveEntity | null> {
    return this.db
      .oneOrNull<WaveEntity>(
        `
        select * from ${WAVES_TABLE} where id = :wave_id`,
        { wave_id },
        { wrappedConnection: connection }
      )
      .then((it) =>
        it
          ? {
              ...it,
              participation_required_media: JSON.parse(
                it.participation_required_media as any
              ),
              participation_required_metadata: JSON.parse(
                it.participation_required_metadata as any
              ),
              decisions_strategy: it.decisions_strategy
                ? JSON.parse(it.decisions_strategy as any)
                : null
            }
          : null
      );
  }

  async deleteWave(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteWave');
    await this.deleteWaveVotingCreditNfts(waveId, ctx);
    await this.db.execute(
      `delete from ${WAVES_TABLE} where id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteWave');
  }

  async deleteWaveVotingCreditNfts(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteWaveVotingCreditNfts');
    await this.db.execute(
      `delete from ${WAVE_VOTING_CREDIT_NFTS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteWaveVotingCreditNfts');
  }

  async insertOutcomes(entities: WaveOutcomeEntity[], ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->insertOutcomes');
    await this.db.bulkInsert(
      WAVE_OUTCOMES_TABLE,
      entities,
      [
        'wave_id',
        'wave_outcome_position',
        'type',
        'subtype',
        'description',
        'credit',
        'rep_category',
        'amount'
      ],
      ctx
    );
    ctx.timer?.stop('wavesApiDb->insertOutcomes');
  }

  async insertOutcomeDistributionItems(
    entities: WaveOutcomeDistributionItemEntity[],
    ctx: RequestContext
  ) {
    ctx.timer?.start('wavesApiDb->insertOutcomeDistributionItems');
    await this.db.bulkInsert(
      WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
      entities,
      [
        'wave_id',
        'wave_outcome_position',
        'wave_outcome_distribution_item_position',
        'amount',
        'description'
      ],
      ctx
    );
    ctx.timer?.stop('wavesApiDb->insertOutcomeDistributionItems');
  }

  async deleteWaveOutcomes(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteWaveOutcomes');
    await this.db.execute(
      `delete from ${WAVE_OUTCOMES_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteWaveOutcomes');
  }

  async deleteWaveOutcomeDistributionItems(
    waveId: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start('wavesApiDb->deleteWaveOutcomeDistributionItems');
    await this.db.execute(
      `delete from ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteWaveOutcomeDistributionItems');
  }

  async deleteWaveMetrics(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteWaveMetrics');
    await this.db.execute(
      `delete from ${WAVE_METRICS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteWaveMetrics');
  }

  async deleteDropPartsByWaveId(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteDropPartsByWaveId');
    await this.db.execute(
      `delete from ${DROPS_PARTS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropPartsByWaveId');
  }

  async deleteDropMentionsByWaveId(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteDropMentionsByWaveId');
    await this.db.execute(
      `delete from ${DROPS_MENTIONS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropMentionsByWaveId');
  }

  async deleteDropMentionedWavesByWaveId(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteDropMentionedWavesByWaveId');
    await this.db.execute(
      `delete from ${DROP_MENTIONED_WAVES_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropMentionedWavesByWaveId');
  }

  public async deleteDropMediaByWaveId(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteDropMediaByWaveId');
    await this.db.execute(
      `delete from ${DROP_MEDIA_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropMediaByWaveId');
  }

  public async deleteDropReferencedNftsByWaveId(
    waveId: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start('wavesApiDb->deleteDropReferencedNftsByWaveId');
    await this.db.execute(
      `delete from ${DROP_REFERENCED_NFTS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropReferencedNftsByWaveId');
  }

  public async deleteDropMetadataByWaveId(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteDropMetadataByWaveId');
    await this.db.execute(
      `delete from ${DROP_METADATA_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropMetadataByWaveId');
  }

  public async deleteDropNotificationsByWaveId(
    waveId: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start('wavesApiDb->deleteDropNotificationsByWaveId');
    await this.db.execute(
      `delete from ${IDENTITY_NOTIFICATIONS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropNotificationsByWaveId');
  }

  public async deleteDropFeedItemsByWaveId(
    waveId: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start('wavesApiDb->deleteDropFeedItemsByWaveId');
    await this.db.execute(
      `delete from ${ACTIVITY_EVENTS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropFeedItemsByWaveId');
  }

  public async deleteDropSubscriptionsByWaveId(
    waveId: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start('wavesApiDb->deleteDropSubscriptionsByWaveId');
    await this.db.execute(
      `delete from ${IDENTITY_SUBSCRIPTIONS_TABLE} where wave_id = :waveId`,
      { waveId, targetType: ActivityEventTargetType.DROP },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropSubscriptionsByWaveId');
  }

  public async deleteDropEntitiesByWaveId(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteDropEntitiesByWaveId');
    await this.db.execute(
      `delete from ${DROPS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropEntitiesByWaveId');
  }

  async updateVisibilityInFeedEntities(
    param: {
      waveId: string;
      newVisibilityGroupId: string | null;
    },
    ctx: RequestContext
  ) {
    ctx.timer?.start('wavesApiDb->updateVisibilityInFeedEntities');
    await this.db.execute(
      `update ${ACTIVITY_EVENTS_TABLE}
       set visibility_group_id = :newVisibilityGroupId
       where wave_id = :waveId`,
      param,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->updateVisibilityInFeedEntities');
  }

  async updateVisibilityInNotifications(
    param: { waveId: string; newVisibilityGroupId: string | null },
    ctx: RequestContext
  ) {
    ctx.timer?.start('wavesApiDb->updateVisibilityInNotifications');
    await this.db.execute(
      `update ${IDENTITY_NOTIFICATIONS_TABLE}
       set visibility_group_id = :newVisibilityGroupId
       where wave_id = :waveId`,
      param,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->updateVisibilityInNotifications');
  }

  async deleteDropRelations(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteDropRelations');
    await this.db.execute(
      `delete from ${DROP_RELATIONS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropRelations');
  }

  async updateDescriptionDropId(
    param: {
      newDescriptionDropId: string;
      waveId: string;
    },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${WAVES_TABLE}
       set description_drop_id = :newDescriptionDropId
       where id = :waveId`,
      param,
      { wrappedConnection: connection }
    );
  }

  async findHotWaves({
    cutoffTimestamp,
    limit,
    offset = 0,
    authenticated_user_id,
    exclude_followed
  }: {
    cutoffTimestamp: number;
    limit: number;
    offset?: number;
    authenticated_user_id: string | null;
    exclude_followed: boolean;
  }): Promise<WaveEntity[]> {
    return this.db
      .execute<RawWaveEntity>(
        `with hot_waves as (
          select w.id, count(*) as drop_count
          from ${WAVES_TABLE} w
          join ${DROPS_TABLE} d on d.wave_id = w.id
          ${
            exclude_followed
              ? `left join ${IDENTITY_SUBSCRIPTIONS_TABLE} f
                  on f.subscriber_id = :authenticated_user_id
                 and f.target_id = w.id
                 and f.target_type = :wave_target_type
                 and f.target_action = :drop_created_action`
              : ``
          }
          where d.created_at >= :cutoffTimestamp
            and w.visibility_group_id is null
            and w.chat_group_id is null
            and w.parent_wave_id is null
            ${exclude_followed ? `and f.id is null` : ``}
	          group by w.id
	          having count(distinct d.author_id) >= 3
	          order by drop_count desc, w.id
	          limit :limit offset :offset
	        )
	        select w.* from ${WAVES_TABLE} w
	        join hot_waves hw on hw.id = w.id
        order by hw.drop_count desc, w.id`,
        {
          cutoffTimestamp,
          limit,
          offset,
          authenticated_user_id,
          wave_target_type: ActivityEventTargetType.WAVE,
          drop_created_action: ActivityEventAction.DROP_CREATED
        }
      )
      .then((res) => res.map((it) => this.parseWaveEntity(it)));
  }

  async findRecentlyDroppedToWaves(param: {
    authenticated_user_id: string | null;
    only_waves_followed_by_authenticated_user: boolean;
    offset: number;
    limit: number;
    eligibleGroups: string[];
    direct_message?: boolean;
    pinned: ApiWavesPinFilter | null;
  }): Promise<WaveEntity[]> {
    const useFollowedSubwaveActivity =
      !!param.authenticated_user_id &&
      param.only_waves_followed_by_authenticated_user;
    const rootSortExpr = param.authenticated_user_id
      ? `CASE WHEN COALESCE(wrm.muted, false) = true THEN 0 ELSE wm.latest_drop_timestamp END`
      : `wm.latest_drop_timestamp`;
    const sortExpr = useFollowedSubwaveActivity
      ? `GREATEST(${rootSortExpr}, COALESCE(fsa.latest_followed_subwave_activity_timestamp, 0))`
      : rootSortExpr;
    const followedSubwaveActivityCte = useFollowedSubwaveActivity
      ? `${this.getFollowedSubwaveActivityCte({
          groupIds: param.eligibleGroups,
          identityParamName: 'authenticated_user_id',
          eligibleGroupsParamName: 'eligibleGroups'
        })},`
      : ``;
    const sql = `with ${followedSubwaveActivityCte} wids as (select w.id, ${sortExpr} as sort_val from ${WAVES_TABLE} w
    ${
      param.pinned === ApiWavesPinFilter.Pinned && param.authenticated_user_id
        ? ` join ${PINNED_WAVES_TABLE} pw on pw.wave_id = w.id and pw.profile_id = :authenticated_user_id `
        : ``
    }
   ${
     param.pinned === ApiWavesPinFilter.NotPinned && param.authenticated_user_id
       ? ` left join ${PINNED_WAVES_TABLE} pw on pw.wave_id = w.id and pw.profile_id = :authenticated_user_id `
       : ``
   }
    ${
      param.only_waves_followed_by_authenticated_user
        ? `left join ${IDENTITY_SUBSCRIPTIONS_TABLE} f
             on f.subscriber_id = :authenticated_user_id
            and f.target_type = :wave_target_type
            and f.target_action = :drop_created_action
            and f.target_id = w.id`
        : ``
    }
    ${
      useFollowedSubwaveActivity
        ? `left join followed_subwave_activity fsa on fsa.parent_wave_id = w.id`
        : ``
    }
    join ${WAVE_METRICS_TABLE} wm on wm.wave_id = w.id 
    ${
      param.authenticated_user_id
        ? `left join ${WAVE_READER_METRICS_TABLE} wrm on wrm.wave_id = w.id and wrm.reader_id = :authenticated_user_id`
        : ``
    }
     where
     ${param.pinned === ApiWavesPinFilter.NotPinned && param.authenticated_user_id ? ` pw.profile_id is null and ` : ``}
    ${
      param.only_waves_followed_by_authenticated_user
        ? `(${useFollowedSubwaveActivity ? `f.id is not null or fsa.parent_wave_id is not null` : `f.id is not null`}) and`
        : ``
    }
     ${
       param.direct_message !== undefined
         ? ` w.is_direct_message = :direct_message and `
         : ``
     }
     w.parent_wave_id is null and
     (w.visibility_group_id is null ${
       param.eligibleGroups.length
         ? `or w.visibility_group_id in (:eligibleGroups)`
         : ``
     }) order by sort_val desc, w.id desc limit :limit offset :offset) select w.* from ${WAVES_TABLE} w join wids on w.id = wids.id order by wids.sort_val desc, w.id desc`;
    return this.db
      .execute<
        Omit<
          WaveEntity,
          | 'participation_required_media'
          | 'participation_required_metadata'
          | 'decisions_strategy'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
          decisions_strategy: string;
        }
      >(sql, {
        ...param,
        wave_target_type: ActivityEventTargetType.WAVE,
        drop_created_action: ActivityEventAction.DROP_CREATED
      })
      .then((res) =>
        res.map((it) => ({
          ...it,
          participation_required_media: JSON.parse(
            it.participation_required_media
          ),
          participation_required_metadata: JSON.parse(
            it.participation_required_metadata
          ),
          decisions_strategy: it.decisions_strategy
            ? JSON.parse(it.decisions_strategy)
            : null
        }))
      );
  }

  async findScoredRecentlyDroppedToWaves(param: {
    authenticated_user_id: string | null;
    only_waves_followed_by_authenticated_user: boolean;
    offset: number;
    limit: number;
    eligibleGroups: string[];
    direct_message?: boolean;
    pinned: ApiWavesPinFilter | null;
    score_sort: ApiWaveScoreSort;
    exclude_followed: boolean;
    min_visibility_score?: number;
    min_quality_score?: number;
    min_hotness_score?: number;
    min_rep_sort_score?: number;
    visibility_tier?: ApiWaveVisibilityTier;
  }): Promise<WaveEntity[]> {
    if (
      param.only_waves_followed_by_authenticated_user &&
      param.exclude_followed
    ) {
      throw new Error(
        'Cannot request followed-only waves and exclude-followed waves together'
      );
    }
    const useFollowedSubwaveActivity =
      !!param.authenticated_user_id &&
      (param.only_waves_followed_by_authenticated_user ||
        param.exclude_followed);
    const applyMutedScoreFloor = (column: string) =>
      param.authenticated_user_id
        ? `CASE WHEN COALESCE(wrm.muted, false) = true THEN 0 ELSE ${column} END`
        : column;
    const scoreColumn = this.getWaveScoreSortColumn(param.score_sort);
    const tierRankExpr = param.authenticated_user_id
      ? `CASE WHEN COALESCE(wrm.muted, false) = true THEN 999 ELSE wm.wave_visibility_rank END`
      : `wm.wave_visibility_rank`;
    const scoreExpr = applyMutedScoreFloor(scoreColumn);
    const visibilityScoreExpr = applyMutedScoreFloor(
      `wm.wave_visibility_score`
    );
    const qualityScoreExpr = applyMutedScoreFloor(`wm.wave_quality_score`);
    const hotnessScoreExpr = applyMutedScoreFloor(`wm.wave_hotness_score`);
    const repSortScoreExpr = applyMutedScoreFloor(`wm.wave_rep_sort_score`);
    const visibilityTierExpr = param.authenticated_user_id
      ? `CASE WHEN COALESCE(wrm.muted, false) = true THEN NULL ELSE wm.wave_visibility_tier END`
      : `wm.wave_visibility_tier`;
    const latestActivityExpr =
      useFollowedSubwaveActivity &&
      param.only_waves_followed_by_authenticated_user
        ? `GREATEST(${applyMutedScoreFloor('wm.latest_drop_timestamp')}, COALESCE(fsa.latest_followed_subwave_activity_timestamp, 0))`
        : `wm.latest_drop_timestamp`;
    const filters = [
      param.min_visibility_score !== undefined
        ? `${visibilityScoreExpr} >= :min_visibility_score`
        : null,
      param.min_quality_score !== undefined
        ? `${qualityScoreExpr} >= :min_quality_score`
        : null,
      param.min_hotness_score !== undefined
        ? `${hotnessScoreExpr} >= :min_hotness_score`
        : null,
      param.min_rep_sort_score !== undefined
        ? `${repSortScoreExpr} >= :min_rep_sort_score`
        : null,
      param.visibility_tier !== undefined
        ? `${visibilityTierExpr} = :visibility_tier`
        : null
    ]
      .filter((it): it is string => !!it)
      .join(' and ');
    const scoreFilters = filters ? `and ${filters}` : ``;
    const followedSubwaveActivityCte = useFollowedSubwaveActivity
      ? `${this.getFollowedSubwaveActivityCte({
          groupIds: param.eligibleGroups,
          identityParamName: 'authenticated_user_id',
          eligibleGroupsParamName: 'eligibleGroups'
        })},`
      : ``;
    const sql = `with ${followedSubwaveActivityCte} wids as (
      select
        w.id,
        ${tierRankExpr} as tier_rank,
        ${scoreExpr} as sort_val,
        ${latestActivityExpr} as latest_drop_timestamp
      from ${WAVES_TABLE} w
      ${
        param.pinned === ApiWavesPinFilter.Pinned && param.authenticated_user_id
          ? ` join ${PINNED_WAVES_TABLE} pw on pw.wave_id = w.id and pw.profile_id = :authenticated_user_id `
          : ``
      }
      ${
        param.pinned === ApiWavesPinFilter.NotPinned &&
        param.authenticated_user_id
          ? ` left join ${PINNED_WAVES_TABLE} pw on pw.wave_id = w.id and pw.profile_id = :authenticated_user_id `
          : ``
      }
      ${
        param.only_waves_followed_by_authenticated_user ||
        param.exclude_followed
          ? `left join ${IDENTITY_SUBSCRIPTIONS_TABLE} f
              on f.subscriber_id = :authenticated_user_id
             and f.target_id = w.id
             and f.target_type = :wave_target_type
             and f.target_action = :drop_created_action`
          : ``
      }
      ${
        useFollowedSubwaveActivity
          ? `left join followed_subwave_activity fsa on fsa.parent_wave_id = w.id`
          : ``
      }
      join ${WAVE_METRICS_TABLE} wm on wm.wave_id = w.id
      ${
        param.authenticated_user_id
          ? `left join ${WAVE_READER_METRICS_TABLE} wrm on wrm.wave_id = w.id and wrm.reader_id = :authenticated_user_id`
          : ``
      }
      where
        ${param.pinned === ApiWavesPinFilter.NotPinned && param.authenticated_user_id ? ` pw.profile_id is null and ` : ``}
        ${
          param.only_waves_followed_by_authenticated_user
            ? `(${useFollowedSubwaveActivity ? `f.id is not null or fsa.parent_wave_id is not null` : `f.id is not null`}) and`
            : ``
        }
        ${
          param.exclude_followed
            ? `f.id is null${useFollowedSubwaveActivity ? ` and fsa.parent_wave_id is null` : ``} and`
            : ``
        }
        ${
          param.direct_message !== undefined
            ? ` w.is_direct_message = :direct_message and `
            : ``
        }
        w.parent_wave_id is null
        and (w.visibility_group_id is null ${
          param.eligibleGroups.length
            ? `or w.visibility_group_id in (:eligibleGroups)`
            : ``
        })
        ${scoreFilters}
      order by tier_rank asc, sort_val desc, latest_drop_timestamp desc, w.id desc
      limit :limit offset :offset
    )
    select w.*
    from ${WAVES_TABLE} w
      join wids on w.id = wids.id
    order by wids.tier_rank asc, wids.sort_val desc, wids.latest_drop_timestamp desc, w.id desc`;
    return this.db
      .execute<RawWaveEntity>(sql, {
        ...param,
        wave_target_type: ActivityEventTargetType.WAVE,
        drop_created_action: ActivityEventAction.DROP_CREATED
      })
      .then((res) => res.map((it) => this.parseWaveEntity(it)));
  }

  async findIdentityParticipationDropsCountByWaveId(
    param: {
      identityId: string;
      waveIds: string[];
    },
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!param.waveIds.length) {
      return {};
    }
    ctx.timer?.start(
      `${this.constructor.name}->findIdentityParticipationDropsCountByWaveId`
    );
    const dbresult = await this.db.execute<{ wave_id: string; cnt: number }>(
      `select d.wave_id as wave_id, count(d.id) as cnt from ${DROPS_TABLE} d where d.wave_id in (:waveIds) and d.author_id = :identityId and d.drop_type = '${DropType.PARTICIPATORY}' group by 1`,
      param,
      { wrappedConnection: ctx.connection }
    );
    const result = dbresult.reduce(
      (acc, red) => ({ ...acc, [red.wave_id]: red.cnt }),
      {} as Record<string, number>
    );
    ctx.timer?.stop(
      `${this.constructor.name}->findIdentityParticipationDropsCountByWaveId`
    );
    return result;
  }

  public async findWaveByGroupId(groupId: string, ctx: RequestContext) {
    const result = await this.db.execute<WaveEntity>(
      `SELECT * FROM ${WAVES_TABLE} WHERE admin_group_id = :groupId OR chat_group_id = :groupId OR voting_group_id = :groupId OR participation_group_id = :groupId ORDER BY created_at DESC LIMIT 1`,
      { groupId },
      { wrappedConnection: ctx.connection }
    );
    return result.length ? result[0] : null;
  }

  async getWavesPauses(
    waveIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, WaveDecisionPauseEntity[]>> {
    if (!waveIds.length) {
      return {};
    }
    const entities = await this.db.execute<WaveDecisionPauseEntity>(
      `select * from ${WAVES_DECISION_PAUSES_TABLE} where wave_id in (:waveIds)`,
      { waveIds },
      { wrappedConnection: ctx.connection }
    );
    return entities.reduce(
      (acc, it) => {
        if (!acc[it.wave_id]) {
          acc[it.wave_id] = [];
        }
        acc[it.wave_id].push(it);
        return acc;
      },
      {} as Record<string, WaveDecisionPauseEntity[]>
    );
  }

  async getWavePauses(
    waveId: string,
    ctx: RequestContext
  ): Promise<WaveDecisionPauseEntity[]> {
    return await this.db.execute<WaveDecisionPauseEntity>(
      `select * from ${WAVES_DECISION_PAUSES_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
  }

  async countWaveDecisionsByWaveIds(
    waveIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!waveIds.length) {
      return {};
    }
    const timerLabel = `${this.constructor.name}->countWaveDecisionsByWaveIds`;
    ctx.timer?.start(timerLabel);
    const rows = await this.db.execute<{ wave_id: string; cnt: number }>(
      `select wave_id, count(*) as cnt from ${WAVES_DECISIONS_TABLE} where wave_id in (:waveIds) group by 1`,
      { waveIds },
      { wrappedConnection: ctx.connection }
    );
    const result = rows.reduce(
      (acc, row) => ({ ...acc, [row.wave_id]: row.cnt }),
      {} as Record<string, number>
    );
    ctx.timer?.stop(timerLabel);
    return result;
  }

  async deletePause(id: number, connection: ConnectionWrapper<any>) {
    await this.db.execute(
      `delete from ${WAVES_DECISION_PAUSES_TABLE} where id = :id`,
      { id },
      { wrappedConnection: connection }
    );
  }

  async insertPause(
    param: { startTime: number; endTime: number; waveId: string },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
      insert into ${WAVES_DECISION_PAUSES_TABLE} (start_time, end_time, wave_id)
      values (:startTime, :endTime, :waveId)
        `,
      param,
      { wrappedConnection: connection }
    );
  }

  async whichOfWavesArePinnedByGivenProfile(
    param: {
      waveIds: string[];
      profileId?: string | null;
    },
    ctx: RequestContext
  ): Promise<Set<string>> {
    if (!param.profileId || !param.waveIds.length) {
      return new Set<string>();
    }
    const results = await this.db.execute<{ wave_id: string }>(
      `select wave_id from ${PINNED_WAVES_TABLE} where profile_id = :profileId and wave_id in (:waveIds)`,
      param,
      { wrappedConnection: ctx.connection }
    );
    return new Set<string>(results.map((it) => it.wave_id));
  }

  async insertPin(
    { waveId, profileId }: { waveId: string; profileId: string },
    ctx: RequestContext
  ) {
    await this.db.execute(
      `insert into ${PINNED_WAVES_TABLE} (wave_id, profile_id) values (:waveId, :profileId) on duplicate key update wave_id = :waveId`,
      { waveId, profileId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deletePin(
    { waveId, profileId }: { waveId: string; profileId: string },
    ctx: RequestContext
  ) {
    await this.db.execute(
      `delete from ${PINNED_WAVES_TABLE} where wave_id = :waveId and profile_id = :profileId`,
      { waveId, profileId },
      { wrappedConnection: ctx.connection }
    );
  }

  async getWavesOutcomes(
    waveIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, WaveOutcomeEntity[]>> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getWaveOutcomes`);
      if (!waveIds.length) {
        return {};
      }
      const dbResult = await this.db.execute<WaveOutcomeEntity>(
        `select * from ${WAVE_OUTCOMES_TABLE} where wave_id in (:waveIds)`,
        { waveIds },
        { wrappedConnection: ctx.connection }
      );
      return dbResult.reduce(
        (acc, it) => {
          if (!acc[it.wave_id]) {
            acc[it.wave_id] = [];
          }
          acc[it.wave_id].push(it);
          return acc;
        },
        {} as Record<string, WaveOutcomeEntity[]>
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getWaveOutcomes`);
    }
  }

  async getWavesOutcomesDistributionItems(
    waveIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, WaveOutcomeDistributionItemEntity[]>> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getWavesOutcomesDistributionItems`
      );
      if (!waveIds.length) {
        return {};
      }
      const dbResult = await this.db.execute<WaveOutcomeDistributionItemEntity>(
        `select * from ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} where wave_id in (:waveIds)`,
        { waveIds },
        { wrappedConnection: ctx.connection }
      );
      return dbResult.reduce(
        (acc, it) => {
          if (!acc[it.wave_id]) {
            acc[it.wave_id] = [];
          }
          acc[it.wave_id].push(it);
          return acc;
        },
        {} as Record<string, WaveOutcomeDistributionItemEntity[]>
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getWavesOutcomesDistributionItems`
      );
    }
  }

  async findOutcomes(
    param: {
      wave_id: string;
      limit: number;
      offset: number;
      order: 'ASC' | 'DESC';
    },
    ctx: RequestContext
  ): Promise<WaveOutcomeEntity[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->findOutcomes`);
      return this.db.execute<WaveOutcomeEntity>(
        `
        select * from ${WAVE_OUTCOMES_TABLE} where wave_id = :wave_id order by wave_outcome_position ${param.order} limit :limit offset :offset
      `,
        param,
        {
          wrappedConnection: ctx.connection
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findOutcomes`);
    }
  }

  async countOutcomes(
    param: {
      wave_id: string;
    },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->countOutcomes`);
      return this.db
        .oneOrNull<{ cnt: number }>(
          `
        select count(*) as cnt from ${WAVE_OUTCOMES_TABLE} where wave_id = :wave_id
      `,
          param,
          {
            wrappedConnection: ctx.connection
          }
        )
        .then((it) => it?.cnt ?? 0);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->countOutcomes`);
    }
  }

  async findOutcomeDistributionItems(
    param: {
      wave_id: string;
      wave_outcome_position: number;
      limit: number;
      offset: number;
      order: 'ASC' | 'DESC';
    },
    ctx: RequestContext
  ): Promise<WaveOutcomeDistributionItemEntity[]> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->findOutcomeDistributionItems`
      );
      return this.db.execute<WaveOutcomeDistributionItemEntity>(
        `
        select * from ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} where wave_id = :wave_id and wave_outcome_position = :wave_outcome_position order by wave_outcome_distribution_item_position ${param.order} limit :limit offset :offset
      `,
        param,
        {
          wrappedConnection: ctx.connection
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findOutcomeDistributionItems`);
    }
  }

  async countOutcomeDistributionItems(
    param: {
      wave_id: string;
      wave_outcome_position: number;
    },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->countOutcomeDistributionItems`
      );
      return this.db
        .oneOrNull<{ cnt: number }>(
          `
        select count(*) as cnt from ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} where wave_id = :wave_id and wave_outcome_position = :wave_outcome_position
      `,
          param,
          {
            wrappedConnection: ctx.connection
          }
        )
        .then((it) => it?.cnt ?? 0);
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->countOutcomeDistributionItems`
      );
    }
  }

  async findWaveReaderMetricsByWaveIds(
    params: { readerId: string; waveIds: string[] },
    { connection, timer }: RequestContext
  ): Promise<Record<string, WaveReaderMetricEntity>> {
    if (!params.waveIds.length) {
      return {};
    }
    timer?.start('wavesApiDb->findWaveReaderMetricsByWaveIds');
    const result = await this.db
      .execute<WaveReaderMetricEntity>(
        `select * from ${WAVE_READER_METRICS_TABLE} where wave_id in (:waveIds) and reader_id = :readerId`,
        params,
        { wrappedConnection: connection }
      )
      .then((results) => {
        const existingMetricsByWaveId = results.reduce(
          (acc, metric) => {
            acc[metric.wave_id] = metric;
            return acc;
          },
          {} as Record<string, WaveReaderMetricEntity>
        );
        return params.waveIds.reduce(
          (acc, waveId) => {
            acc[waveId] = existingMetricsByWaveId[waveId] ?? {
              wave_id: waveId,
              reader_id: params.readerId,
              latest_read_timestamp: 0,
              muted: false
            };
            return acc;
          },
          {} as Record<string, WaveReaderMetricEntity>
        );
      });
    timer?.stop('wavesApiDb->findWaveReaderMetricsByWaveIds');
    return result;
  }

  async updateWaveReaderMetricLatestReadTimestamp(
    waveId: string,
    readerId: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start(
      `${this.constructor.name}->updateWaveReaderMetricLatestReadTimestamp`
    );
    const now = Time.now().toMillis();
    await this.db.execute(
      `insert into ${WAVE_READER_METRICS_TABLE} (wave_id, reader_id, latest_read_timestamp)
       values (:waveId, :readerId, :now)
       on duplicate key update latest_read_timestamp = :now`,
      { waveId, readerId, now },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(
      `${this.constructor.name}->updateWaveReaderMetricLatestReadTimestamp`
    );
  }

  async setWaveReaderMetricLatestReadTimestamp(
    waveId: string,
    readerId: string,
    timestamp: number,
    ctx: RequestContext
  ) {
    ctx.timer?.start(
      `${this.constructor.name}->setWaveReaderMetricLatestReadTimestamp`
    );
    await this.db.execute(
      `insert into ${WAVE_READER_METRICS_TABLE} (wave_id, reader_id, latest_read_timestamp)
       values (:waveId, :readerId, :timestamp)
       on duplicate key update latest_read_timestamp = :timestamp`,
      { waveId, readerId, timestamp },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(
      `${this.constructor.name}->setWaveReaderMetricLatestReadTimestamp`
    );
  }

  async insertMissingWaveReaderMetrics(
    param: {
      waveId: string;
      readerIds: string[];
      latestReadTimestamp: number;
    },
    ctx: RequestContext
  ) {
    const readerIds = Array.from(new Set(param.readerIds));
    if (!readerIds.length) {
      return;
    }
    ctx.timer?.start(
      `${this.constructor.name}->insertMissingWaveReaderMetrics`
    );
    await this.db.bulkInsert(
      WAVE_READER_METRICS_TABLE,
      readerIds.map((readerId) => ({
        wave_id: param.waveId,
        reader_id: readerId,
        latest_read_timestamp: param.latestReadTimestamp
      })),
      ['wave_id', 'reader_id', 'latest_read_timestamp'],
      ctx,
      {
        connection: ctx.connection,
        ignoreDuplicates: true
      }
    );
    ctx.timer?.stop(`${this.constructor.name}->insertMissingWaveReaderMetrics`);
  }

  async findExistingWaveReaderMetricReaderIds(
    param: {
      waveId: string;
      readerIds: string[];
    },
    ctx: RequestContext
  ): Promise<string[]> {
    const readerIds = Array.from(new Set(param.readerIds));
    if (!readerIds.length) {
      return [];
    }
    ctx.timer?.start(
      `${this.constructor.name}->findExistingWaveReaderMetricReaderIds`
    );
    const result = await this.db.execute<{ reader_id: string }>(
      `select reader_id
       from ${WAVE_READER_METRICS_TABLE}
       where wave_id = :waveId
         and reader_id in (:readerIds)`,
      {
        waveId: param.waveId,
        readerIds
      },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(
      `${this.constructor.name}->findExistingWaveReaderMetricReaderIds`
    );
    return result.map((row) => row.reader_id);
  }

  async setWaveMuted(
    param: { waveId: string; readerId: string; muted: boolean },
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->setWaveMuted`);
    await this.db.execute(
      `insert into ${WAVE_READER_METRICS_TABLE} (wave_id, reader_id, muted, latest_read_timestamp)
       values (:waveId, :readerId, :muted, ROUND(UNIX_TIMESTAMP(NOW(3)) * 1000))
       on duplicate key update muted = :muted`,
      param,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->setWaveMuted`);
  }

  async findIdentityUnreadDropsSummaryByWaveId(
    param: {
      identityId: string;
      waveIds: string[];
    },
    ctx: RequestContext
  ): Promise<Record<string, WaveUnreadSummary>> {
    if (!param.waveIds.length) {
      return {};
    }

    const timerLabel = `${this.constructor.name}->findIdentityUnreadDropsSummaryByWaveId`;
    ctx.timer?.start(timerLabel);
    try {
      const { cachedByWaveId, uncachedWaveIds, cacheKeysByWaveId } =
        await readWaveUnreadSummaryCache(param.identityId, param.waveIds);
      if (!uncachedWaveIds.length) {
        return cachedByWaveId;
      }

      const dbSummariesByWaveId = await withInFlightWaveUnreadSummaryCacheMiss({
        identityId: param.identityId,
        waveIds: uncachedWaveIds,
        cacheKeysByWaveId,
        getValue: async () => {
          // Reader metrics are the unread baseline source of truth. Without
          // a reader row we do not infer unread drops from old wave history.
          const dbresult = await this.db.execute<WaveUnreadSummaryRow>(
            `
                SELECT d.wave_id AS wave_id,
                       COUNT(d.id) AS unread_drops_count,
                       MIN(d.serial_no) AS first_unread_drop_serial_no
                FROM ${DROPS_TABLE} d USE INDEX (idx_drop_wave_created_at)
                JOIN ${WAVE_READER_METRICS_TABLE} r
                  ON r.wave_id = d.wave_id
                  AND r.reader_id = :identityId
                LEFT JOIN ${IDENTITY_MUTES_TABLE} im
                  ON im.muter_id = :identityId
                  AND im.muted_identity_id = d.author_id
                WHERE d.wave_id IN (:waveIds)
                  AND d.author_id != :identityId
                  AND im.id IS NULL
                  AND d.created_at > r.latest_read_timestamp
                  AND r.muted = false
                GROUP BY d.wave_id
              `,
            { identityId: param.identityId, waveIds: uncachedWaveIds },
            { wrappedConnection: ctx.connection }
          );

          const uncachedSummariesByWaveId = uncachedWaveIds.reduce(
            (acc, waveId) => {
              acc[waveId] = {
                unread_drops_count: 0,
                first_unread_drop_serial_no: null
              };
              return acc;
            },
            {} as Record<string, WaveUnreadSummary>
          );
          const summariesByWaveId = dbresult.reduce((acc, row) => {
            acc[row.wave_id] = {
              unread_drops_count: Number(row.unread_drops_count),
              first_unread_drop_serial_no: this.toNullableNumber(
                row.first_unread_drop_serial_no
              )
            };
            return acc;
          }, uncachedSummariesByWaveId);
          await writeWaveUnreadSummaryCache({
            summariesByWaveId,
            cacheKeysByWaveId
          });
          return summariesByWaveId;
        }
      });

      return { ...cachedByWaveId, ...dbSummariesByWaveId };
    } finally {
      ctx.timer?.stop(timerLabel);
    }
  }

  async findIdentityUnreadDropsCountByWaveId(
    param: {
      identityId: string;
      waveIds: string[];
    },
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    const summaries = await this.findIdentityUnreadDropsSummaryByWaveId(
      param,
      ctx
    );
    return Object.entries(summaries).reduce(
      (acc, [waveId, summary]) => {
        acc[waveId] = summary.unread_drops_count;
        return acc;
      },
      {} as Record<string, number>
    );
  }

  async findFirstUnreadDropSerialNoByWaveId(
    param: {
      identityId: string;
      waveIds: string[];
    },
    ctx: RequestContext
  ): Promise<Record<string, number | null>> {
    const summaries = await this.findIdentityUnreadDropsSummaryByWaveId(
      param,
      ctx
    );
    return Object.entries(summaries).reduce(
      (acc, [waveId, summary]) => {
        acc[waveId] = summary.first_unread_drop_serial_no;
        return acc;
      },
      {} as Record<string, number | null>
    );
  }

  async countIdentityUnreadDmDrops(
    param: {
      identityId: string;
      eligibleGroups: string[];
    },
    ctx: RequestContext
  ): Promise<number> {
    const timerLabel = `${this.constructor.name}->countIdentityUnreadDmDrops`;
    ctx.timer?.start(timerLabel);
    try {
      const row = await this.db.oneOrNull<UnreadDmDropsCountRow>(
        `
          SELECT COUNT(d.id) AS count
          FROM ${DROPS_TABLE} d
          JOIN ${WAVE_READER_METRICS_TABLE} r
            ON r.wave_id = d.wave_id
           AND r.reader_id = :identityId
          JOIN ${WAVES_TABLE} w
            ON w.id = d.wave_id
           AND w.is_direct_message = true
          LEFT JOIN ${IDENTITY_MUTES_TABLE} im
            ON im.muter_id = :identityId
           AND im.muted_identity_id = d.author_id
          LEFT JOIN ${WAVES_TABLE} parent
            ON parent.id = w.parent_wave_id
          WHERE d.author_id != :identityId
            AND im.id IS NULL
            AND d.created_at > COALESCE(r.latest_read_timestamp, 0)
            AND r.muted = false
            AND ${this.getWaveAndParentVisibilityFilter(
              'w',
              'parent',
              param.eligibleGroups,
              'eligibleGroups'
            )}
        `,
        { identityId: param.identityId, eligibleGroups: param.eligibleGroups },
        { wrappedConnection: ctx.connection }
      );
      return Number(row?.count ?? 0);
    } finally {
      ctx.timer?.stop(timerLabel);
    }
  }

  async deleteBoosts(waveId: string, ctx: RequestContext) {
    await this.db.execute(
      `DELETE FROM ${DROP_BOOSTS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
  }
}

export interface InsertWaveEntity extends Omit<WaveEntity, 'serial_no'> {
  readonly serial_no: number | null;
  readonly is_direct_message: boolean;
  readonly voting_credit_nfts: readonly WaveVotingCreditNft[];
}

export interface SearchWavesParams {
  readonly author?: string;
  readonly name?: string;
  readonly limit: number;
  readonly offset?: number;
  readonly serial_no_less_than?: number;
  readonly group_id?: string;
  readonly direct_message?: boolean;
}

export const wavesApiDb = new WavesApiDb(dbSupplier);
