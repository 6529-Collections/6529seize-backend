import { withCompetitionSchemaConnection } from './competition-schema';
import { DB_TEXT_COLLATION } from '@/db/db-collation';
import { randomUUID } from 'node:crypto';
import { Logger } from '@/logging';
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
import type { ConnectionWrapper, SqlExecutor } from '@/sql-executor';
import {
  WAVE_HUB_PARTICIPATION_FIELDS,
  WAVE_HUB_VOTING_FIELDS
} from '@/waves/wave-hub-configuration';

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
const nativePrimary = `c.legacy_wave_id=c.wave_id`;
/**
 * The facade's native-primary ownership predicate over a competitions alias
 * `c`: base-table replacements of the views (legacy-typed-drops.ts) join
 * competition entries under exactly this rule.
 */
export const LEGACY_NATIVE_PRIMARY_SQL = nativePrimary;
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
  kind: 'text' | 'number' | 'boolean' | 'json' = 'text',
  alias = 'c'
): string {
  const raw = `json_extract(${alias}.${path.split('.')[0]}, '$.${path.split('.').slice(1).join('.')}')`;
  const nullable =
    alias === 'w'
      ? `case when json_type(${raw})='NULL' then null else json_unquote(${raw}) end`
      : `nullif(json_unquote(${raw}), 'null')`;
  if (kind === 'boolean')
    return `case ${nullable} when 'true' then 1 when 'false' then 0 else cast(${nullable} as signed) end`;
  return kind === 'number'
    ? `cast(${nullable} as signed)`
    : kind === 'json'
      ? `if(json_type(${raw})='NULL', null, ${raw})`
      : `convert(${nullable} using utf8mb4) collate ${DB_TEXT_COLLATION}`;
}

const waveFields: Readonly<Record<string, string>> = {
  // A wave rename never rewrites its original competition title.
  name: 'w.name',
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
        from: `(select c.wave_id,n.contract,n.token_id from ${owners} join json_table(c.voting_config,'$.credit_nfts[*]' columns(contract varchar(50) path '$.contract',token_id bigint path '$.token_id')) n where ${nativePrimary}
          union all select w.id as wave_id,n.contract,n.token_id from ${WAVES_TABLE} w
          join json_table(w.hub_voting_config,'$.credit_nfts[*]' columns(contract varchar(50) path '$.contract',token_id bigint path '$.token_id')) n
          where not exists(select 1 from ${owners} where c.legacy_wave_id=w.id and ${nativePrimary})) hub_nfts`,
        fields: {
          wave_id: 'hub_nfts.wave_id',
          // JSON_TABLE output is not a table column; pin it to the column
          // collation so joins on tdh_nft.contract keep the primary key.
          contract: `convert(hub_nfts.contract using utf8mb4) collate ${DB_TEXT_COLLATION}`,
          token_id: 'hub_nfts.token_id'
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
          vote: `convert(r.real_time_rating using utf8mb4) collate ${DB_TEXT_COLLATION}`,
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
  'hide_link_preview',
  'collapse_replies'
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

const hubNumberFields = new Set([
  'participation_max_applications_per_participant',
  'participation_period_start',
  'participation_period_end',
  'voting_period_start',
  'voting_period_end',
  'max_votes_per_identity_to_drop',
  'time_lock_ms'
]);

export function nativeWaveHubField(column: string): string | undefined {
  if (column === 'decisions_strategy')
    return json('hub_voting_config.decision_strategy', 'json', 'w');
  const participation = WAVE_HUB_PARTICIPATION_FIELDS as Readonly<
    Record<string, string>
  >;
  const voting = WAVE_HUB_VOTING_FIELDS as Readonly<Record<string, string>>;
  const policy = participation[column]
    ? 'hub_participation_config'
    : voting[column]
      ? 'hub_voting_config'
      : undefined;
  if (!policy) return undefined;
  const field = participation[column] ?? voting[column];
  const kind = LEGACY_GET_BOOLEAN_FIELDS.has(column)
    ? 'boolean'
    : hubNumberFields.has(column)
      ? 'number'
      : column === 'participation_required_metadata' ||
          column === 'participation_required_media'
        ? 'json'
        : 'text';
  return `case when w.${policy} is null then ${CHAT_WAVE_COMPATIBILITY_DEFAULTS[column] ?? 'null'} else ${json(`${policy}.${field}`, kind, 'w')} end`;
}

/** Shared configuration reads never select a competition's projected rules. */
export function waveHubSelectColumns(): string {
  return [
    ...sharedWaveColumns.map((column) => `w.\`${column}\``),
    'w.hub_participation_config',
    'w.hub_voting_config',
    ...Object.keys(waveFields).map(
      (column) =>
        `${nativeWaveHubField(column) ?? CHAT_WAVE_COMPATIBILITY_DEFAULTS[column] ?? 'null'} as \`${column}\``
    )
  ].join(',');
}

export function legacyCompetitionGetViewDefinition(table: string): string {
  if (table === WAVES_TABLE) {
    const shared = sharedWaveColumns.map((column) => `w.\`${column}\``);
    const configuration = Object.entries(waveFields).map(
      ([column, field]) =>
        `case when ${nativePrimary} then ${field} else ${nativeWaveHubField(column) ?? CHAT_WAVE_COMPATIBILITY_DEFAULTS[column] ?? 'null'} end as \`${column}\``
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

/**
 * Replacing a hot view takes an exclusive metadata lock. While it waits behind
 * a running reader, every new reader of that view queues behind it, so every
 * DDL statement of the install waits at most this long and is retried a
 * bounded number of times; the run fails rather than stalling the API.
 */
export const FACADE_LOCK_WAIT_SECONDS = 2;
export const FACADE_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];
/** Executions per DDL statement: the first try plus one per retry delay. */
export const FACADE_DDL_ATTEMPTS = FACADE_RETRY_DELAYS_MS.length + 1;
const ER_LOCK_WAIT_TIMEOUT = 1205;
const CANDIDATE_PREFIX = 'lgf_candidate_';
/** LIKE pattern for CANDIDATE_PREFIX: `_` escaped so it matches literally. */
export const CANDIDATE_LIKE_PATTERN = String.raw`lgf\_candidate\_%`;

export interface LegacyCompetitionGetFacadeInstall {
  readonly replaced: string[];
  readonly unchanged: string[];
}

interface InstalledViewDefinition {
  readonly view_definition: string;
  readonly security_type: string;
  readonly character_set_client: string;
  readonly collation_connection: string;
}

type FacadeQueryOptions = { wrappedConnection: ConnectionWrapper<unknown> };
type Sleep = (ms: number) => Promise<void>;

const facadeLogger = Logger.get('LEGACY_COMPETITION_GET_FACADE');

function isLockWaitTimeout(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (('errno' in error && error.errno === ER_LOCK_WAIT_TIMEOUT) ||
      ('code' in error && error.code === 'ER_LOCK_WAIT_TIMEOUT'))
  );
}

/** Additive views installed before native-only readers are deployed.
 * Only views whose definition changed are replaced (see isFacadeViewCurrent),
 * so routine migration runs take no locks on the hot views. */
export async function installLegacyCompetitionGetFacade(
  db: SqlExecutor,
  options: { sleep?: Sleep } = {}
): Promise<LegacyCompetitionGetFacadeInstall> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const result: LegacyCompetitionGetFacadeInstall = {
    replaced: [],
    unchanged: []
  };
  try {
    await withCompetitionSchemaConnection(
      db,
      async ({ connection }) => {
        const queryOptions = { wrappedConnection: connection };
        await sweepCandidateViews(db, queryOptions);
        for (const table of LEGACY_GET_SOURCE_TABLES) {
          const view = legacyGetView(table);
          const definition = legacyCompetitionGetViewDefinition(table);
          if (
            await isFacadeViewCurrent(db, queryOptions, view, definition, sleep)
          ) {
            result.unchanged.push(view);
            continue;
          }
          await executeFacadeDdl(
            db,
            queryOptions,
            `create or replace sql security invoker view \`${view}\` as ${definition}`,
            `Facade view ${view}`,
            sleep
          );
          result.replaced.push(view);
        }
      },
      FACADE_LOCK_WAIT_SECONDS
    );
  } catch (error) {
    // DDL auto-commits; report what this run already changed before failing.
    facadeLogger.error('[FACADE_VIEWS_INSTALL_FAILED]', {
      replaced: result.replaced,
      unchanged: result.unchanged.length
    });
    throw error;
  }
  facadeLogger.info('[FACADE_VIEWS_INSTALLED]', {
    replaced: result.replaced,
    unchanged: result.unchanged.length
  });
  return result;
}

/** Runs one DDL statement under the short lock wait, retrying lock timeouts. */
async function executeFacadeDdl(
  db: SqlExecutor,
  queryOptions: FacadeQueryOptions,
  sql: string,
  subject: string,
  sleep: Sleep
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.execute(sql, {}, queryOptions);
      return;
    } catch (error) {
      if (!isLockWaitTimeout(error)) throw error;
      if (attempt >= FACADE_DDL_ATTEMPTS)
        throw new Error(
          `${subject} stayed locked after ${attempt} attempts of ${FACADE_LOCK_WAIT_SECONDS}s; not replaced`
        );
      await sleep(FACADE_RETRY_DELAYS_MS[attempt - 1]);
    }
  }
}

/**
 * Drops comparison views left by an earlier run that died between creating
 * and dropping one. If a concurrent run's candidate is swept, that run only
 * sees "changed" and replaces its view once, under the same bounded wait.
 */
async function sweepCandidateViews(
  db: SqlExecutor,
  queryOptions: FacadeQueryOptions
): Promise<void> {
  const leftovers = await db.execute<{ name: string }>(
    `select table_name as name from information_schema.views
     where table_schema = database() and table_name like :pattern`,
    { pattern: CANDIDATE_LIKE_PATTERN },
    queryOptions
  );
  for (const { name } of leftovers) {
    if (!/^lgf_candidate_[0-9a-f]{12}$/.test(name)) continue;
    await dropCandidate(db, queryOptions, name);
  }
}

async function dropCandidate(
  db: SqlExecutor,
  queryOptions: FacadeQueryOptions,
  candidate: string
): Promise<void> {
  try {
    await db.execute(`drop view if exists \`${candidate}\``, {}, queryOptions);
  } catch (error) {
    // Never mask the comparison's own outcome; the next run sweeps it.
    facadeLogger.warn('[FACADE_CANDIDATE_DROP_FAILED]', {
      candidate,
      code:
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'UNKNOWN'
    });
  }
}

async function readInstalledView(
  db: SqlExecutor,
  queryOptions: FacadeQueryOptions,
  view: string
): Promise<InstalledViewDefinition | null> {
  return db.oneOrNull<InstalledViewDefinition>(
    `select view_definition as view_definition, security_type as security_type,
            character_set_client as character_set_client,
            collation_connection as collation_connection
     from information_schema.views
     where table_schema = database() and table_name = :view`,
    { view },
    queryOptions
  );
}

/**
 * MySQL stores a normalized view definition, so compare like with like: create
 * the desired definition under a throwaway name (it locks only that name, not
 * the live view), read both normalized forms back, and drop the throwaway
 * view. Both are normalized by the same server in the same session, so an
 * unchanged definition compares equal. A view last created by another server
 * version or session collation may normalize differently; it is then replaced
 * once (under the bounded wait) and compares equal on later runs.
 */
async function isFacadeViewCurrent(
  db: SqlExecutor,
  queryOptions: FacadeQueryOptions,
  view: string,
  definition: string,
  sleep: Sleep
): Promise<boolean> {
  const installed = await readInstalledView(db, queryOptions, view);
  if (!installed) return false;
  const candidate = `${CANDIDATE_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  try {
    await executeFacadeDdl(
      db,
      queryOptions,
      `create sql security invoker view \`${candidate}\` as ${definition}`,
      `Facade comparison view for ${view}`,
      sleep
    );
    const desired = await readInstalledView(db, queryOptions, candidate);
    // A missing candidate row deliberately counts as "changed".
    return (
      !!desired &&
      desired.view_definition === installed.view_definition &&
      desired.security_type === installed.security_type &&
      desired.character_set_client === installed.character_set_client &&
      desired.collation_connection === installed.collation_connection
    );
  } finally {
    await dropCandidate(db, queryOptions, candidate);
  }
}
