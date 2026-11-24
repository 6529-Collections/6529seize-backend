import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { toApiCompetition } from '@/api/competitions/competition-api.mapper';
import { DropSignedEventsService } from '@/api/device-signing/drop-signed-events.service';
import { deviceSigningDb } from '@/api/device-signing/device-signing.db';
import {
  dropPollsDb,
  DropPollsOrderBy,
  DropPollState
} from '@/api/drops/drop-polls.db';
import { dropsService } from '@/api/drops/drops.api.service';
import { dropsMappers } from '@/api/drops/drops.mappers';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { ApiDropSearchStrategy } from '@/api/generated/models/ApiDropSearchStrategy';
import { ApiGroupFull } from '@/api/generated/models/ApiGroupFull';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { PageSortDirection } from '@/api/page-request';
import { waveApiService } from '@/api/waves/wave.api.service';
import { AuthenticationContext } from '@/auth-context';
import {
  anonymousCompetitionAuthor,
  competitionAnonymityService
} from '@/competitions/competition-anonymity';
import { competitionDropVotesDb } from '@/competitions/competition-drop-votes.db';
import { collectCompetitionPages } from '@/competitions/competition-page';
import { competitionRepository } from '@/competitions/competition.repository';
import { PublicCompetition } from '@/competitions/competition.service';
import { CompetitionEntry } from '@/competitions/competition.types';
import { NativeCompetitionReader } from '@/competitions/native-competition.reader';
import {
  legacyGetView,
  withLegacyCompetitionGetFacade,
  withoutLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import {
  COMPETITIONS_TABLE,
  DROPS_TABLE,
  RATINGS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { dropsDb } from '@/drops/drops.db';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { DropType } from '@/entities/IDrop';
import { RateMatter } from '@/entities/IRating';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { stableGrant } from './waves-export.compact';
import {
  DropTableRow,
  dropTableValues,
  withTableValues
} from './waves-export.table';
import { compareCodePoints } from './waves-export.json';
import {
  ExportActiveEntry,
  ExportCompetition,
  ExportGroupMember,
  ExportSignedDrop,
  ExportVoteLogRow,
  ExportWaveRepRow,
  ExportWaveRow,
  Json,
  WavesExportSource
} from './waves-export.types';

const ALL_ENTRY_STATUSES = [
  CompetitionEntryStatus.ACTIVE,
  CompetitionEntryStatus.WITHDRAWN,
  CompetitionEntryStatus.DISQUALIFIED,
  CompetitionEntryStatus.WINNER
];

const LOG_PAGE = 500;
const POLL_PAGE = 200;
const IN_BATCH = 1000;

/** What a guest's permissions on a decision are (the API's for no reader). */
const GUEST_COMPETITION_PERMISSIONS: PublicCompetition['permissions'] = {
  view: true,
  submit: false,
  vote: false,
  administer: false,
  edit_rules_after_activity: false,
  edit_credit_rules: false
};

function toNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function toMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? date : null;
}

/** A JSON round trip: what the API's response body holds. */
function asJson<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

/**
 * The table values of the drops `ids`, by id, read from the drops table
 * itself: outside the legacy competition facade, whose view of drops
 * shows a native entry's type as the API does.
 */
async function dropTableValuesByIds(
  ids: readonly string[]
): Promise<Map<string, Json>> {
  if (!ids.length) return new Map();
  // Outside the facade by construction, wherever the caller runs.
  const rows = await withoutLegacyCompetitionGetFacade(() =>
    sqlExecutor.execute<DropTableRow>(
      `select id, signature, is_additional_action_promised, hide_link_preview,
         collapse_replies, drop_type, reply_to_part_id
       from ${DROPS_TABLE} where id in (:ids)`,
      { ids }
    )
  );
  return new Map(rows.map((row) => [row.id, dropTableValues(row)]));
}

/**
 * The API reads every GET outside /v3 inside the legacy competition facade
 * (api-serverless app.ts), which shows a primary decision's entry drops as
 * PARTICIPATORY or WINNER drops. Reads that stand for such a GET run inside
 * it too, so they give what the public API gives.
 */
function asLegacyGet<T>(read: () => Promise<T>): Promise<T> {
  return withLegacyCompetitionGetFacade(read);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * The export's reads, through 6529.io's own services and mappers, with the
 * context of a reader who is not signed in: what the public API shows a
 * guest, except that the entry points' read checks are skipped, so
 * members-only waves, private groups, every entry status and draft decisions
 * come out too. Direct-message waves are never read.
 */
export class BackendWavesExportSource implements WavesExportSource {
  private readonly ctx: RequestContext = {
    authenticationContext: AuthenticationContext.notAuthenticated()
  };

  async listWaves(): Promise<ExportWaveRow[]> {
    const rows = await sqlExecutor.execute<ExportWaveRow>(
      // The submit and vote groups of a wave's original decision come from
      // the legacy view, as every other wave read takes them.
      `select w.id, w.parent_wave_id, w.visibility_group_id, w.admin_group_id,
          w.chat_group_id, lw.participation_group_id, lw.voting_group_id
        from ${WAVES_TABLE} w
        left join ${legacyGetView(WAVES_TABLE)} lw on lw.id = w.id
        left join ${WAVES_TABLE} p on p.id = w.parent_wave_id
        where coalesce(w.is_direct_message, 0) = 0
          and coalesce(p.is_direct_message, 0) = 0`
    );
    return [...rows].sort((a, b) => compareCodePoints(a.id, b.id));
  }

  async waveConfiguration(
    wave: ExportWaveRow,
    eligibleGroupIds: string[]
  ): Promise<Json> {
    // The /v3/waves/{id} configuration: the wave hub's shared configuration,
    // with the wave's own groups eligible so a private group shows its id.
    return asJson(
      await waveApiService.findWaveByIdOrThrow(
        wave.id,
        eligibleGroupIds,
        this.ctx,
        true
      )
    );
  }

  async listCompetitionIds(waveIds: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const batch of chunks(waveIds, IN_BATCH)) {
      if (!batch.length) continue;
      const rows = await sqlExecutor.execute<{ id: string }>(
        `select id from ${COMPETITIONS_TABLE} where wave_id in (:waveIds)`,
        { waveIds: batch }
      );
      ids.push(...rows.map((row) => row.id));
    }
    return ids.sort(compareCodePoints);
  }

  async competition(competitionId: string): Promise<ExportCompetition | null> {
    const record = await competitionRepository.findCompetitionRecordById(
      competitionId,
      this.ctx
    );
    if (!record) return null;
    const reader = new NativeCompetitionReader(competitionRepository, this.ctx);
    const competition = await reader.getCompetition(record, Date.now());
    const {
      execution_mode: _execution,
      decision_pauses: _pauses,
      configuration_activated_at: _activatedAt,
      ...publicData
    } = competition;
    const api = toApiCompetition({
      ...publicData,
      your_active_entries_count: null,
      permissions: GUEST_COMPETITION_PERMISSIONS
    });
    const [entries, decisions, outcomes, pauses, voters] = await Promise.all([
      collectCompetitionPages((page) =>
        reader.listEntries(record, page, ALL_ENTRY_STATUSES)
      ),
      collectCompetitionPages((page) => reader.listDecisions(record, page)),
      collectCompetitionPages((page) => reader.listOutcomes(record, page)),
      collectCompetitionPages((page) => reader.listPauses(record, page)),
      collectCompetitionPages((page) => reader.listVoters(record, page))
    ]);
    // An anonymous decision's open entries name their submitter by the
    // same stable pseudonym the API gives a reader (toApiEntryPage): the
    // file the chain imports is public.
    const hidden = await competitionAnonymityService.hiddenDropIds(
      entries.map((entry) => entry.drop_id),
      this.ctx
    );
    return {
      competition: asJson(api),
      details: {
        // The API names an entry's submitter by its profile object; the
        // export by its id, the one field the import reads.
        entries: entries.map((entry) => {
          const { submitter_id, ...rest } = entry;
          const submitter = hidden.has(entry.drop_id)
            ? anonymousCompetitionAuthor({ id: submitter_id }, entry.drop_id).id
            : submitter_id;
          return asJson({ ...rest, submitter: { id: submitter } });
        }),
        decisions: decisions.map(asJson),
        outcomes: outcomes.map(asJson),
        pauses: pauses.map(asJson),
        versions: [],
        voters: voters.map(asJson)
      }
    };
  }

  async entryVotes(entry: ExportActiveEntry): Promise<Json[]> {
    const record = await competitionRepository.findCompetitionRecordById(
      entry.competition_id,
      this.ctx
    );
    if (!record) {
      throw new Error(`Decision ${entry.competition_id} not found`);
    }
    const reader = new NativeCompetitionReader(competitionRepository, this.ctx);
    const votes = await collectCompetitionPages((page) =>
      reader.listEntryVotes(record, entry.entry_id, page)
    );
    return votes.map(asJson);
  }

  /**
   * The entry's vote edit log as `/v2/drops/{id}/votes/logs` gives it: the
   * drop read as that GET reads it decides between the decision's vote
   * history (a native entry drop) and the legacy vote edit log.
   */
  async entryVoteLog(entry: ExportActiveEntry): Promise<ExportVoteLogRow[]> {
    const drop = await asLegacyGet(() => dropsDb.findDropById(entry.drop_id));
    if (!drop) {
      throw new Error(`Entry drop ${entry.drop_id} not found`);
    }
    const rows: ExportVoteLogRow[] = [];
    if (drop.drop_type === DropType.COMPETITION) {
      const native = await competitionRepository.findNativeEntry(
        entry.competition_id,
        entry.entry_id,
        this.ctx
      );
      if (!native) {
        throw new Error(`Entry ${entry.entry_id} not found`);
      }
      for (let offset = 0; ; offset += LOG_PAGE) {
        const page = await competitionDropVotesDb.logs(
          native as CompetitionEntry,
          offset,
          LOG_PAGE,
          'DESC',
          this.ctx
        );
        rows.push(
          ...page.map((row) => ({
            id: row.id,
            old_vote: toNumber(row.old_vote),
            new_vote: toNumber(row.new_vote),
            created_at: toNumber(row.created_at)
          }))
        );
        if (page.length < LOG_PAGE) break;
      }
      return rows;
    }
    for (let offset = 0; ; offset += LOG_PAGE) {
      const page = await asLegacyGet(() =>
        dropsDb.findDropVoteEditLogEntities(
          {
            wave_id: drop.wave_id,
            drop_id: drop.id,
            offset,
            limit: LOG_PAGE,
            sort_direction: PageSortDirection.DESC
          },
          this.ctx
        )
      );
      rows.push(
        ...page.map((log) => {
          const contents = parseVoteLogContents(log.contents);
          return {
            id: log.id,
            old_vote: toNumber(contents.oldVote),
            new_vote: toNumber(contents.newVote),
            created_at: toMillis(log.created_at) ?? 0
          };
        })
      );
      if (page.length < LOG_PAGE) break;
    }
    return rows;
  }

  async groups(groupIds: string[]): Promise<Record<string, Json>> {
    const out: Record<string, Json> = {};
    for (const batch of chunks(groupIds, 200)) {
      for (const group of await asLegacyGet(() =>
        userGroupsService.findByIdsForExport(batch, this.ctx)
      )) {
        out[group.id] = asJson(group);
      }
    }
    return out;
  }

  async identityGroupWallets(identityGroupId: string): Promise<string[]> {
    return userGroupsService.findUserGroupsIdentityGroupIdentities(
      identityGroupId
    );
  }

  async groupMembers(group: Json): Promise<ExportGroupMember[]> {
    // The membership SQL rewrites the definition's rater names in place:
    // give it a copy, so the saved definition stays as the API shows it.
    const membership = await asLegacyGet(() =>
      userGroupsService.getSqlAndParamsForExport(
        structuredClone(group) as unknown as ApiGroupFull,
        this.ctx
      )
    );
    if (!membership) return [];
    const rows = await sqlExecutor.execute<{
      wallet: string | null;
      key: string | null;
    }>(
      `${membership.sql}
       select cm.primary_address as wallet,
         ifnull(cm.handle, cm.primary_address) as \`key\`
       from ${UserGroupsService.GENERATED_VIEW} cm order by cm.primary_address`,
      membership.params
    );
    return rows
      .filter((row) => !!row.wallet)
      .map((row) => ({ wallet: row.wallet!, key: row.key }));
  }

  async profileIdOf(identityKey: string): Promise<string | null> {
    return identityFetcher.getProfileIdByIdentityKey({ identityKey }, this.ctx);
  }

  async waveRep(
    waveIds: string[]
  ): Promise<Record<string, ExportWaveRepRow[]>> {
    const out: Record<string, ExportWaveRepRow[]> = {};
    for (const batch of chunks(waveIds, IN_BATCH)) {
      if (!batch.length) continue;
      const rows = await sqlExecutor.execute<{
        wave_id: string;
        category: string;
        profile_id: string;
        rating: number | string;
        last_modified: Date | string | number | null;
      }>(
        `select matter_target_id as wave_id, matter_category as category,
            rater_profile_id as profile_id, rating, last_modified
          from ${RATINGS_TABLE}
          where matter = :matter and rating <> 0 and matter_target_id in (:waveIds)
          order by matter_target_id, matter_category, rater_profile_id`,
        { matter: RateMatter.WAVE_REP, waveIds: batch }
      );
      for (const row of rows) {
        (out[row.wave_id] ??= []).push({
          category: row.category,
          profile_id: row.profile_id,
          rating: toNumber(row.rating),
          last_modified: toMillis(row.last_modified)
        });
      }
    }
    return out;
  }

  async wavePolls(
    waveId: string,
    state: 'OPEN' | 'CLOSED',
    nowMillis: number
  ): Promise<Json[]> {
    const dropIds: string[] = [];
    for (let offset = 0; ; offset += POLL_PAGE) {
      const polls = await asLegacyGet(() =>
        dropPollsDb.findWavePolls(
          {
            waveId,
            limit: POLL_PAGE,
            offset,
            order: PageSortDirection.DESC,
            orderBy: DropPollsOrderBy.CREATED_AT,
            state: state === 'OPEN' ? DropPollState.OPEN : DropPollState.CLOSED,
            now: nowMillis
          },
          this.ctx
        )
      );
      dropIds.push(...polls.map((poll) => poll.drop_id));
      if (polls.length < POLL_PAGE) break;
    }
    if (!dropIds.length) return [];
    const drops = await asLegacyGet(() =>
      dropsService.findDropsV2ByIds(dropIds, this.ctx)
    );
    return dropIds
      .map((dropId) => drops[dropId])
      .filter((drop) => drop !== undefined)
      .map(asJson);
  }

  async *wavePagesOfDrops(
    waveId: string,
    pageSize: number
  ): AsyncIterable<Json[]> {
    let serialNoLimit = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const read = await asLegacyGet(async () => {
        const entities = await dropsDb.findLatestDropsSimple(
          {
            wave_id: waveId,
            amount: pageSize,
            serial_no_limit: serialNoLimit,
            search_strategy: ApiDropSearchStrategy.Older,
            drop_type: null,
            exclude_replies: false
          },
          this.ctx
        );
        const drops = entities.length
          ? await dropsMappers.convertToDropsWithoutWaves(entities, this.ctx)
          : [];
        return { entities, drops };
      });
      if (!read.entities.length) return;
      // Each drop with its table's own values, which the API's drop lacks.
      const tableOf = await dropTableValuesByIds(
        read.entities.map((entity) => entity.id)
      );
      yield withTableValues(read.drops.map(asJson), tableOf);
      serialNoLimit = Math.min(
        ...read.entities.map((entity) => entity.serial_no)
      );
    }
  }

  async signedEvents(drops: Json[]): Promise<ExportSignedDrop[]> {
    // The public batch read and its single read, over drops already read:
    // the same hiding rules (moderation, anonymous authors), no read check.
    const byId = new Map(drops.map((drop) => [String(drop.id), drop]));
    const service = new DropSignedEventsService(
      deviceSigningDb,
      {
        findReadableDropsByIds: async (ids: string[]) =>
          ids
            .map((id) => byId.get(id))
            .filter((drop) => drop !== undefined) as unknown as ApiDrop[],
        findDropByIdOrThrow: async ({ dropId }: { dropId: string }) => {
          const drop = byId.get(dropId);
          if (!drop) throw new Error(`Drop ${dropId} is not in this page`);
          return drop as unknown as ApiDrop;
        }
      } as never,
      competitionAnonymityService
    );
    const ids = Array.from(byId.keys());
    const batch = asJson(
      await asLegacyGet(() => service.findForDrops(ids, this.ctx))
    );
    const grants = new Map<string, Json>();
    for (const grant of (batch.grants as Json[] | undefined) ?? []) {
      grants.set(String(grant.id), stableGrant(grant));
    }
    const out = new Map<string, ExportSignedDrop>();
    for (const item of (batch.drops as Json[] | undefined) ?? []) {
      const events = (item.events as Json[] | undefined) ?? [];
      const refs = Array.from(
        new Set(
          events
            .map((event) => event.auth_ref)
            .filter((ref): ref is string => typeof ref === 'string' && !!ref)
        )
      ).sort(compareCodePoints);
      out.set(String(item.drop_id), {
        drop_id: String(item.drop_id),
        current_event_id: (item.current_event_id as string | null) ?? null,
        events,
        grants: refs
          .filter((ref) => grants.has(ref))
          .map((ref) => grants.get(ref)!)
      });
    }
    for (const dropId of (batch.truncated_drop_ids as string[] | undefined) ??
      []) {
      const single = asJson(
        await asLegacyGet(() => service.findForDrop(dropId, this.ctx))
      );
      out.set(dropId, {
        drop_id: dropId,
        current_event_id: (single.current_event_id as string | null) ?? null,
        events: (single.events as unknown[] | undefined) ?? [],
        grants: ((single.grants as Json[] | undefined) ?? [])
          .map(stableGrant)
          .sort((a, b) => compareCodePoints(String(a.id), String(b.id)))
      });
    }
    return Array.from(out.values());
  }
}

function parseVoteLogContents(contents: unknown): {
  oldVote?: unknown;
  newVote?: unknown;
} {
  try {
    const parsed =
      typeof contents === 'string' ? JSON.parse(contents) : contents;
    return parsed && typeof parsed === 'object'
      ? (parsed as { oldVote?: unknown; newVote?: unknown })
      : {};
  } catch {
    return {};
  }
}
