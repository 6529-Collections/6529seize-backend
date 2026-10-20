import { withCompetitionSchemaConnection } from './competition-schema';
import { AsyncLocalStorage } from 'node:async_hooks';
import { INDEFINITE_COMPETITION_PAUSE_END } from './competition-phase';
import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  COMPETITION_PAUSES_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  WAVES_TABLE,
  DROPS_TABLE,
  DROP_RANK_TABLE,
  DROP_VOTER_STATE_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVES_DECISIONS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVE_OUTCOMES_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WINNER_DROP_VOTER_VOTES_TABLE
} from '@/constants/db-tables';
import type { SqlExecutor } from '@/sql-executor';

const scope = new AsyncLocalStorage<boolean>();
export const LEGACY_GET_BOOLEAN_FIELDS = new Set([
  'participation_signature_required',
  'voting_signature_required',
  'forbid_negative_votes'
]);
export function isLegacyCompetitionGetFacadeScope(): boolean {
  return scope.getStore() === true;
}
export function withLegacyCompetitionGetFacade<T>(action: () => T): T {
  // Synchronous scope setup: this returns exactly the callback's result. It
  // neither creates a Promise nor intercepts downstream router errors.
  return scope.run(true, action);
}
export function withoutLegacyCompetitionGetFacade<T>(action: () => T): T {
  return scope.run(false, action);
}
// Frozen ownership is intentionally independent of the current default competition.
const nativePrimary = `c.storage_mode='NATIVE' and c.legacy_wave_id=c.wave_id`;
const owners = `${COMPETITIONS_TABLE} c`;
const entries = `${COMPETITION_ENTRIES_TABLE} e join ${owners} on c.id=e.competition_id and ${nativePrimary}`;

export const LEGACY_GET_SOURCE_TABLES = [
  WAVES_TABLE,
  DROPS_TABLE,
  DROP_RANK_TABLE,
  DROP_VOTER_STATE_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVES_DECISIONS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVE_OUTCOMES_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WINNER_DROP_VOTER_VOTES_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE
] as const;
export function legacyGetView(table: string): string {
  if (!LEGACY_GET_SOURCE_TABLES.some((source) => source === table))
    throw new Error('Unsupported compatibility source');
  return `legacy_get_${table}`;
}

type SqlToken = { readonly value: string; readonly index: number };
const SQL_TOKEN_PATTERN = new RegExp(
  [
    /'(?:\\.|''|[^'\\])*'/.source,
    /"(?:\\.|""|[^"\\])*"/.source,
    /`[^`]+`/.source,
    /--[^\n]*/.source,
    /\/\*[\s\S]*?\*\//.source,
    /[A-Za-z_][A-Za-z_0-9]*/.source,
    /\s+/.source,
    /./.source
  ].join('|'),
  'g'
);

function isSelectQuery(tokens: readonly SqlToken[]): boolean {
  let depth = 0;
  const command = tokens.find(({ value }) => {
    if (value === '(') {
      depth++;
      return false;
    }
    if (value === ')') {
      depth--;
      return false;
    }
    return (
      depth === 0 && /^(select|insert|update|delete|replace)$/i.test(value)
    );
  });
  return command?.value.toLowerCase() === 'select';
}
function fromNesting(
  previous: string,
  nesting: number,
  inFrom: Set<number>
): number {
  if (previous === '(') nesting++;
  if (previous === ')') {
    inFrom.delete(nesting);
    nesting--;
  }
  if (/^from$/i.test(previous)) inFrom.add(nesting);
  if (/^(where|group|order|having|limit|union)$/i.test(previous))
    inFrom.delete(nesting);
  return nesting;
}
function hasTableAlias(next: string): boolean {
  return (
    /^as$/i.test(next) ||
    (/^[a-z_][a-z_0-9]*$/i.test(next) &&
      !/^(where|left|right|inner|outer|cross|join|on|group|order|limit|union|having|for|use|force|ignore)$/i.test(
        next
      ))
  );
}
function removeViewIndexHints(
  tokens: string[],
  meaningful: readonly SqlToken[],
  firstHint: number
): void {
  // Views have no named indexes. Source predicates can still use base-table indexes.
  let hint = firstHint;
  while (/^(force|use|ignore)$/i.test(meaningful[hint]?.value ?? '')) {
    let end = hint + 1;
    while (end < meaningful.length && meaningful[end].value !== ')') end++;
    if (end >= meaningful.length)
      throw new Error('Malformed legacy query index hint');
    for (
      let index = meaningful[hint].index;
      index <= meaningful[end].index;
      index++
    )
      tokens[index] = '';
    hint = end + 1;
  }
}
function rewriteLegacyGetTable(
  tokens: string[],
  meaningful: readonly SqlToken[],
  index: number
): void {
  const token = meaningful[index];
  const table = token.value.replace(/^`|`$/g, '');
  if (!LEGACY_GET_SOURCE_TABLES.some((source) => source === table)) return;
  const next = (meaningful[index + 1]?.value ?? '').replace(/^`|`$/g, '');
  const hasAlias = hasTableAlias(next);
  // Preserve implicit table-qualified column names as well as explicit aliases.
  let replacement = `\`${legacyGetView(table)}\``;
  let hint = index + 1;
  if (hasAlias) hint += /^as$/i.test(next) ? 2 : 1;
  else replacement += ` as \`${table}\``;
  tokens[token.index] = replacement;
  removeViewIndexHints(tokens, meaningful, hint);
}

/** Rewrite only table identifiers after FROM/JOIN in repository-owned SELECTs.
 * Strings, quoted values, comments and mutations are never interpreted as SQL.
 * The explicit request scope keeps baseline SQL and native commands independent. */
export function legacyCompetitionGetSql(sql: string): string {
  if (!scope.getStore()) return sql;
  const tokens = sql.match(SQL_TOKEN_PATTERN) ?? [];
  const meaningful = tokens
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => !/^\s|^--|^\/\*/.test(value));
  if (!isSelectQuery(meaningful)) return sql;
  let nesting = 0;
  const inFrom = new Set<number>();
  for (let index = 1; index < meaningful.length; index++) {
    const previous = meaningful[index - 1].value;
    nesting = fromNesting(previous, nesting, inFrom);
    if (
      !/^(from|join)$/i.test(previous) &&
      !(previous === ',' && inFrom.has(nesting))
    )
      continue;
    rewriteLegacyGetTable(tokens, meaningful, index);
  }
  return tokens.join('');
}

function json(
  path: string,
  kind: 'text' | 'number' | 'boolean' | 'json' = 'text'
): string {
  const raw = `json_extract(c.${path.split('.')[0]}, '$.${path.split('.').slice(1).join('.')}')`;
  const nullable = `nullif(json_unquote(${raw}), 'null')`;
  if (kind === 'boolean')
    return `case ${nullable} when 'true' then 1 when 'false' then 0 else cast(${nullable} as signed) end`;
  return kind === 'number'
    ? `cast(${nullable} as signed)`
    : kind === 'json'
      ? `if(json_type(${raw})='NULL', null, ${raw})`
      : `convert(${nullable} using utf8mb4) collate utf8mb4_unicode_ci`;
}

const waveFields: Readonly<Record<string, string>> = {
  name: 'c.title',
  // The native config normalizes an untouched legacy null to created_at.
  updated_at:
    'case when w.updated_at is null and c.updated_at=c.created_at then null else c.updated_at end',
  type: 'c.type',
  participation_group_id: json('participation_config.group_id'),
  participation_signature_required: json(
    'participation_config.signature_required',
    'boolean'
  ),
  participation_max_applications_per_participant: json(
    'participation_config.max_entries_per_participant',
    'number'
  ),
  participation_required_metadata: json(
    'participation_config.required_metadata',
    'json'
  ),
  participation_required_media: json(
    'participation_config.required_media',
    'json'
  ),
  submission_type: json('participation_config.submission_type'),
  identity_submission_strategy: json(
    'participation_config.identity_submission_strategy'
  ),
  identity_submission_duplicates: json(
    'participation_config.identity_submission_duplicates'
  ),
  participation_period_start: 'c.participation_starts_at',
  participation_period_end: 'c.participation_ends_at',
  participation_terms: json('participation_config.terms'),
  voting_group_id: json('voting_config.group_id'),
  voting_signature_required: json(
    'voting_config.signature_required',
    'boolean'
  ),
  voting_credit_type: json('voting_config.credit_type'),
  voting_credit_scope: json('voting_config.credit_scope'),
  voting_credit_category: json('voting_config.credit_category'),
  voting_credit_creditor: json('voting_config.credit_creditor'),
  voting_period_start: 'c.voting_starts_at',
  voting_period_end: 'c.voting_ends_at',
  max_votes_per_identity_to_drop: json(
    'voting_config.max_votes_per_identity_to_entry',
    'number'
  ),
  forbid_negative_votes: json('voting_config.forbid_negative_votes', 'boolean'),
  decisions_strategy: json('decision_config.strategy', 'json'),
  next_decision_time: json('decision_config.next_decision_time', 'number'),
  winning_min_threshold: json(
    'decision_config.winning_min_threshold',
    'number'
  ),
  winning_max_threshold: json(
    'decision_config.winning_max_threshold',
    'number'
  ),
  winning_threshold_min_duration_ms: json(
    'decision_config.winning_threshold_min_duration_ms',
    'number'
  ),
  max_winners: json('decision_config.max_winners', 'number'),
  time_lock_ms: json('decision_config.time_lock_ms', 'number')
};

export const RETIRED_WAVE_COMPETITION_COLUMNS = Object.keys(waveFields).filter(
  (column) => column !== 'name' && column !== 'updated_at'
);

function nativeSelects(table: string): {
  from: string;
  fields: Readonly<Record<string, string>>;
} {
  switch (table) {
    case DROP_REAL_VOTE_IN_TIME_TABLE:
    case DROP_REAL_VOTER_VOTE_IN_TIME_TABLE:
      return {
        from: `${owners} join ${COMPETITION_SCORE_HISTORY_TABLE} h on h.competition_id=c.id where ${nativePrimary} and h.kind='${table === DROP_REAL_VOTE_IN_TIME_TABLE ? 'AGGREGATE' : 'VOTER'}'`,
        fields: {
          id: 'h.sequence',
          drop_id: 'h.drop_id',
          wave_id: 'c.wave_id',
          timestamp: 'h.occurred_at',
          vote: 'h.value',
          ...(table === DROP_REAL_VOTER_VOTE_IN_TIME_TABLE
            ? { voter_id: 'h.voter_profile_id' }
            : {})
        }
      };

    case WAVES_DECISION_PAUSES_TABLE:
      return {
        from: `${owners} join ${COMPETITION_PAUSES_TABLE} p on p.competition_id=c.id where ${nativePrimary} and p.legacy_source_id is not null`,
        fields: {
          id: 'p.legacy_source_id',
          wave_id: 'c.wave_id',
          start_time: 'p.start_time',
          end_time: `coalesce(p.end_time,${INDEFINITE_COMPETITION_PAUSE_END})`,
          reason: 'p.reason'
        }
      };
    case WAVE_VOTING_CREDIT_NFTS_TABLE:
      return {
        from: `${owners} join json_table(c.voting_config,'$.credit_nfts[*]' columns(contract varchar(50) path '$.contract',token_id bigint path '$.token_id')) n where ${nativePrimary}`,
        fields: {
          wave_id: 'c.wave_id',
          // JSON_TABLE inherits the session collation; the frozen source used Unicode CI.
          contract:
            'convert(n.contract using utf8mb4) collate utf8mb4_unicode_ci',
          token_id: 'n.token_id'
        }
      };
    case DROP_RANK_TABLE:
      return {
        // An unvoted source entry has no rank row. Preserve that absence, while
        // including subsequent native votes even before the first increase.
        // Winners retain only rank rows that existed in their source history.
        from: `${entries} join ${COMPETITION_ENTRY_RUNTIME_TABLE} r on r.entry_id=e.id and r.competition_id=c.id where ((e.status='ACTIVE' and (r.last_increased_at is not null or r.real_time_rating<>0)) or (e.status='WINNER' and r.last_increased_at is not null))`,
        fields: {
          drop_id: 'e.drop_id',
          wave_id: 'c.wave_id',
          // The frozen rank column is VARCHAR, including its wire primitive type.
          vote: 'convert(r.real_time_rating using utf8mb4) collate utf8mb4_unicode_ci',
          last_increased: 'coalesce(r.last_increased_at,e.submitted_at)'
        }
      };
    case DROP_VOTER_STATE_TABLE:
      return {
        from: `${entries} join ${COMPETITION_VOTES_TABLE} v on v.entry_id=e.id and v.competition_id=c.id`,
        fields: {
          drop_id: 'e.drop_id',
          wave_id: 'c.wave_id',
          voter_id: 'v.voter_profile_id',
          votes: 'v.value'
        }
      };
    case WAVE_LEADERBOARD_ENTRIES_TABLE:
      return {
        from: `${owners} join ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} lb on lb.competition_id=c.id
          left join ${COMPETITION_ENTRIES_TABLE} e on e.id=lb.entry_id and e.competition_id=c.id
          left join ${COMPETITION_ENTRY_RUNTIME_TABLE} r on r.entry_id=e.id and r.competition_id=c.id
          where ${nativePrimary} and (e.status='ACTIVE' or e.id is null) and lb.published_at is not null`,
        fields: {
          drop_id: 'coalesce(e.drop_id,lb.drop_id)',
          wave_id: 'c.wave_id',
          vote: 'lb.rating',
          vote_on_decision_time: 'coalesce(lb.decision_rating,lb.rating)',
          timestamp:
            'case when e.id is null then lb.ordering_time else coalesce(lb.ordering_time,r.last_increased_at,e.submitted_at) end',
          over_threshold_since_ms:
            'case when e.id is null then lb.over_threshold_since else r.over_threshold_since end'
        }
      };
    case WAVES_DECISIONS_TABLE:
      return {
        from: `${owners} join ${COMPETITION_DECISIONS_TABLE} d on d.competition_id=c.id where ${nativePrimary} and d.status='COMPLETED'`,
        fields: { wave_id: 'c.wave_id', decision_time: 'd.scheduled_at' }
      };
    case WAVES_DECISION_WINNER_DROPS_TABLE:
      return {
        from: `${owners} join ${COMPETITION_DECISION_WINNERS_TABLE} win on win.competition_id=c.id join ${COMPETITION_DECISIONS_TABLE} d on d.competition_id=c.id and d.id=win.decision_id left join ${COMPETITION_ENTRIES_TABLE} e on e.id=win.entry_id and e.competition_id=c.id where ${nativePrimary} and coalesce(win.legacy_drop_id,e.drop_id) is not null`,
        fields: {
          wave_id: 'c.wave_id',
          decision_time: 'd.scheduled_at',
          drop_id: 'coalesce(win.legacy_drop_id,e.drop_id)',
          // Frozen ranking is INT; the driver's native BIGINT is a string.
          ranking: 'cast(win.rank as double)',
          final_vote: 'win.final_rating',
          prizes: `coalesce((select json_arrayagg(a.award) over(order by a.outcome_position,a.id rows between unbounded preceding and unbounded following) from ${COMPETITION_OUTCOME_AWARDS_TABLE} a where a.competition_id=c.id and a.decision_id=d.id and a.entry_id=win.entry_id limit 1),json_array())`
        }
      };
    case WAVE_OUTCOMES_TABLE:
      return {
        from: `${owners} join ${COMPETITION_OUTCOMES_TABLE} o on o.competition_id=c.id where ${nativePrimary}`,
        fields: {
          wave_id: 'c.wave_id',
          wave_outcome_position: 'o.position',
          type: 'o.type',
          subtype: 'o.subtype',
          description: 'o.description',
          credit: 'o.credit',
          rep_category: 'o.rep_category',
          amount: 'o.amount'
        }
      };
    case WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE:
      return {
        from: `${owners} join ${COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE} i on i.competition_id=c.id
          left join ${COMPETITION_OUTCOMES_TABLE} o on o.id=i.outcome_id and o.competition_id=c.id
          where ${nativePrimary} and (o.id is not null or (i.outcome_position is not null and not exists(
            select 1 from ${COMPETITION_OUTCOMES_TABLE} parent where parent.competition_id=c.id and parent.position=i.outcome_position)))`,
        fields: {
          wave_id: 'c.wave_id',
          wave_outcome_position: 'coalesce(i.outcome_position,o.position)',
          wave_outcome_distribution_item_position: 'i.position',
          description: 'i.description',
          amount: 'i.amount'
        }
      };
    case WINNER_DROP_VOTER_VOTES_TABLE:
      return {
        from: `${entries} join ${COMPETITION_WINNER_VOTES_TABLE} v on v.entry_id=e.id and v.competition_id=c.id and v.decision_id=e.decision_id`,
        fields: {
          wave_id: 'c.wave_id',
          drop_id: 'e.drop_id',
          voter_id: 'v.voter_profile_id',
          votes: 'v.value'
        }
      };
    default:
      throw new Error('No native compatibility definition');
  }
}

// Public projection schemas are explicit. They must remain installable when the
// retired physical competition tables and wave competition columns are absent.
const sharedWaveColumns = [
  'id',
  'serial_no',
  'parent_wave_id',
  'picture',
  'description_drop_id',
  'created_by',
  'created_at',
  'admin_group_id',
  'visibility_group_id',
  'chat_enabled',
  'chat_group_id',
  'chat_slow_mode_cooldown_ms',
  'chat_links_disabled',
  'chat_replies_open',
  'chat_replies_collapsed',
  'admin_drop_deletion_enabled',
  'is_direct_message'
] as const;
const sharedDropColumns = [
  'id',
  'serial_no',
  'wave_id',
  'author_id',
  'created_at',
  'updated_at',
  'title',
  'parts_count',
  'reply_to_drop_id',
  'reply_to_part_id',
  'signature',
  'is_additional_action_promised',
  'hide_link_preview'
] as const;
export const CHAT_WAVE_COMPATIBILITY_DEFAULTS: Readonly<
  Record<string, string>
> = {
  name: 'w.name',
  updated_at: 'w.updated_at',
  type: "'CHAT'",
  participation_group_id:
    'case when w.is_direct_message=1 then w.visibility_group_id else null end',
  voting_credit_type: "'TDH'",
  voting_credit_scope: "'WAVE'",
  participation_signature_required: '0',
  voting_signature_required: '0',
  participation_required_metadata: 'json_array()',
  participation_required_media: 'json_array()',
  forbid_negative_votes: '0',
  winning_threshold_min_duration_ms: '0'
};

export function legacyCompetitionGetViewDefinition(table: string): string {
  if (table === WAVES_TABLE) {
    const shared = sharedWaveColumns.map((column) => `w.\`${column}\``);
    const configuration = Object.entries(waveFields).map(
      ([column, field]) =>
        `case when ${nativePrimary} then ${field} else ${CHAT_WAVE_COMPATIBILITY_DEFAULTS[column] ?? 'null'} end as \`${column}\``
    );
    return `select ${[...shared, ...configuration].join(',')} from ${WAVES_TABLE} w left join ${owners} on c.legacy_wave_id=w.id and ${nativePrimary}`;
  }
  if (table === DROPS_TABLE) {
    // The retained shared category preserves orphan display identity only;
    // native membership remains the authority for voting and decisions.
    const shared = sharedDropColumns.map((column) => `d.\`${column}\``);
    return `select ${shared.join(',')},case when e.status='WINNER' then 'WINNER' when e.status='ACTIVE' then 'PARTICIPATORY' when e.status in ('WITHDRAWN','DISQUALIFIED') or d.drop_type='COMPETITION' then 'CHAT' else d.drop_type end as drop_type from ${DROPS_TABLE} d left join ${owners} on c.legacy_wave_id=d.wave_id and ${nativePrimary} left join ${COMPETITION_ENTRIES_TABLE} e on e.competition_id=c.id and e.drop_id=d.id`;
  }
  // Competition-only resources have no physical-source fallback. The stable
  // source identifiers in native rows preserve historical public identities.
  const native = nativeSelects(table);
  return `select ${Object.entries(native.fields)
    .map(([column, field]) => `${field} as \`${column}\``)
    .join(',')} from ${native.from}`;
}

/** Additive views installed before native-only readers are deployed. */
export async function installLegacyCompetitionGetFacade(
  db: SqlExecutor
): Promise<void> {
  await withCompetitionSchemaConnection(db, async ({ connection }) => {
    for (const table of LEGACY_GET_SOURCE_TABLES) {
      await db.execute(
        `create or replace sql security invoker view \`${legacyGetView(table)}\` as ${legacyCompetitionGetViewDefinition(table)}`,
        {},
        { wrappedConnection: connection }
      );
    }
  });
}
