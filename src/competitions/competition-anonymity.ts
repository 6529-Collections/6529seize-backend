import { COMPETITION_ENTRIES_TABLE, COMPETITIONS_TABLE } from '@/constants';
import { stableUuid } from '@/competitions/competition-id';
import { ApiProfileClassification } from '@/api/generated/models/ApiProfileClassification';
import { getWaveReadContextProfileId } from '@/api/waves/wave-access.helpers';
import { DbPoolName } from '@/db-query.options';
import { getRequestScopedPromise, RequestContext } from '@/request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';

const ANONYMOUS_AUTHOR_NAMESPACE = 'f13441ae-1085-4e7f-9a9c-dddbeee973d9';

/** A delegate without READ_WAVE must never inherit private owner attribution. */
export function competitionAnonymityViewerId(
  ctx: RequestContext
): string | null {
  return getWaveReadContextProfileId(ctx.authenticationContext);
}

/** This is entry-local: another entry by a winner must remain anonymous. */
export function anonymousCompetitionEntrySql(
  entryAlias: string,
  competitionAlias: string
): string {
  return `(json_unquote(json_extract(${competitionAlias}.participation_config, '$.anonymous_submissions')) = 'true' and ${entryAlias}.won_at is null)`;
}

/** Apply before author-filtered pagination/counts, never after fetching a page. */
export function publicCompetitionDropSql(
  dropAlias: string,
  viewerParam?: string
): string {
  const owner = viewerParam
    ? ` and anonymous_entry.submitter_id <> coalesce(:${viewerParam}, '')`
    : '';
  return `not exists (select 1 from ${COMPETITION_ENTRIES_TABLE} anonymous_entry
    join ${COMPETITIONS_TABLE} anonymous_competition on anonymous_competition.id = anonymous_entry.competition_id
    where anonymous_entry.drop_id = ${dropAlias}.id
      and ${anonymousCompetitionEntrySql('anonymous_entry', 'anonymous_competition')}${owner})`;
}

/** Preserve old clients' required profile shape without carrying real identity. */
export function anonymousCompetitionAuthor<T extends { id: string | null }>(
  profile: T,
  dropId: string
): T {
  return {
    id: stableUuid(ANONYMOUS_AUTHOR_NAMESPACE, dropId),
    is_anonymous: true,
    handle: 'Anonymous',
    ...('normalised_handle' in profile
      ? {
          normalised_handle: 'Anonymous',
          display: 'Anonymous',
          consolidation_key: '',
          primary_wallet: '',
          banner1: null,
          banner2: null
        }
      : {}),
    primary_address: '',
    ...('badges' in profile ? {} : { pfp: null }),
    banner1_color: null,
    banner2_color: null,
    classification: ApiProfileClassification.Pseudonym,
    sub_classification: null,
    level: 0,
    cic: 0,
    rep: 0,
    tdh: 0,
    tdh_rate: 0,
    xtdh: 0,
    xtdh_rate: 0,
    subscribed_actions: [],
    archived: false,
    active_main_stage_submission_ids: [],
    winner_main_stage_drop_ids: [],
    artist_of_prevote_cards: [],
    profile_wave_id: null,
    is_wave_creator: false,
    ...('top_rep_categories' in profile ? { top_rep_categories: [] } : {}),
    ...('bio' in profile && !('badges' in profile) ? { bio: null } : {}),
    ...('badges' in profile
      ? {
          badges: {
            artist_of_main_stage_submissions: 0,
            artist_of_memes: 0
          }
        }
      : {})
  } as unknown as T;
}

export class CompetitionAnonymityService extends LazyDbAccessCompatibleService {
  public constructor(db: () => SqlExecutor = dbSupplier) {
    super(db);
  }

  /** includeOwner is for public broadcasts, which must never inherit a viewer. */
  public async hiddenDropIds(
    dropIds: readonly string[],
    ctx: RequestContext,
    options: { includeOwner?: boolean } = {}
  ): Promise<Set<string>> {
    if (!dropIds.length) return new Set();
    const ids = Array.from(new Set(dropIds)).sort((a, b) => a.localeCompare(b));
    const viewer = options.includeOwner
      ? null
      : competitionAnonymityViewerId(ctx);
    const read = async () => {
      const rows = await this.db.execute<{ drop_id: string }>(
        `select distinct e.drop_id from ${COMPETITION_ENTRIES_TABLE} e
           join ${COMPETITIONS_TABLE} c on c.id = e.competition_id
           where e.drop_id in (:ids) and ${anonymousCompetitionEntrySql('e', 'c')}
             and e.submitter_id <> coalesce(:viewer, '')`,
        { ids, viewer },
        {
          wrappedConnection: ctx.connection,
          // A replica can miss a freshly committed membership entirely and
          // falsely classify its author as public, including outside a tx.
          forcePool: DbPoolName.WRITE
        }
      );
      return new Set(rows.map((row) => row.drop_id));
    };
    // A decision may reveal an entry within the transaction using this context.
    if (ctx.connection) return read();
    return getRequestScopedPromise(
      ctx,
      `competition-anonymity:${JSON.stringify([ids, viewer])}`,
      read
    );
  }
}

export const competitionAnonymityService = new CompetitionAnonymityService();
