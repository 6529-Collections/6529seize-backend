import { withMigrationSchemaConnection } from './competition-migration-schema';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
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
  COMPETITION_LEGACY_MIRROR_PERMITS_TABLE,
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
const nativePrimary = `(c.storage_mode='NATIVE' or exists(select 1 from ${COMPETITION_LEGACY_MIRROR_PERMITS_TABLE} p where p.competition_id=c.id and p.connection_id=connection_id() and p.depth=-1)) and c.legacy_wave_id=c.wave_id`;
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
  WAVES_DECISION_PAUSES_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE
] as const;
export function legacyGetView(table: string): string {
  if (!LEGACY_GET_SOURCE_TABLES.some((source) => source === table))
    throw new Error('Unsupported compatibility source');
  return `legacy_get_${table}`;
}

/** Rewrite only table identifiers after FROM/JOIN in repository-owned SELECTs.
 * Strings, quoted values, comments and mutations are never interpreted as SQL.
 * The explicit request scope keeps baseline SQL and native commands independent. */
export function legacyCompetitionGetSql(sql: string): string {
  if (!scope.getStore()) return sql;
  const tokens =
    sql.match(
      /'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"|`[^`]+`|--[^\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z_0-9]*|\s+|./g
    ) ?? [];
  const meaningful = tokens
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => !/^\s|^--|^\/\*/.test(value));
  let depth = 0;
  const command = meaningful.find(({ value }) => {
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
  if (command?.value.toLowerCase() !== 'select') return sql;
  let nesting = 0;
  const inFrom = new Set<number>();
  for (let i = 1; i < meaningful.length; i++) {
    const previous = meaningful[i - 1].value;
    if (previous === '(') nesting++;
    if (previous === ')') {
      inFrom.delete(nesting);
      nesting--;
    }
    if (/^from$/i.test(previous)) inFrom.add(nesting);
    if (/^(where|group|order|having|limit|union)$/i.test(previous))
      inFrom.delete(nesting);
    if (
      !/^(from|join)$/i.test(previous) &&
      !(previous === ',' && inFrom.has(nesting))
    )
      continue;
    const token = meaningful[i];
    const table = token.value.replace(/^`|`$/g, '');
    if (!LEGACY_GET_SOURCE_TABLES.some((source) => source === table)) continue;
    const next = (meaningful[i + 1]?.value ?? '').replace(/^`|`$/g, '');
    // Preserve implicit table-qualified column names as well as explicit aliases.
    const hasAlias =
      /^(as)$/i.test(next) ||
      (/^[a-z_][a-z_0-9]*$/i.test(next) &&
        !/^(where|left|right|inner|outer|cross|join|on|group|order|limit|union|having|for|use|force|ignore)$/i.test(
          next
        ));
    tokens[token.index] =
      `\`${legacyGetView(table)}\`${hasAlias ? '' : ` as \`${table}\``}`;
    // Views have no named indexes. The optimizer can push predicates to the
    // original indexed tables; source hints cannot be applied to a view.
    let hint = i + 1 + (hasAlias ? (/^as$/i.test(next) ? 2 : 1) : 0);
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
      : nullable;
}

const waveFields: Readonly<Record<string, string>> = {
  name: 'c.title',
  updated_at: 'c.updated_at',
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

function nativeSelects(table: string): {
  from: string;
  fields: Readonly<Record<string, string>>;
} {
  switch (table) {
    case WAVES_DECISION_PAUSES_TABLE:
      return {
        from: `${owners} join ${COMPETITION_PAUSES_TABLE} p on p.competition_id=c.id where ${nativePrimary} and p.legacy_source_id is not null`,
        fields: {
          id: 'p.legacy_source_id',
          wave_id: 'c.wave_id',
          start_time: 'p.start_time',
          end_time: 'p.end_time'
        }
      };
    case WAVE_VOTING_CREDIT_NFTS_TABLE:
      return {
        from: `${owners} join json_table(c.voting_config,'$.credit_nfts[*]' columns(contract varchar(50) path '$.contract',token_id bigint path '$.token_id')) n where ${nativePrimary}`,
        fields: {
          wave_id: 'c.wave_id',
          contract: 'n.contract',
          token_id: 'n.token_id'
        }
      };
    case DROP_RANK_TABLE:
      return {
        from: `${entries} join ${COMPETITION_ENTRY_RUNTIME_TABLE} r on r.entry_id=e.id and r.competition_id=c.id where e.status='ACTIVE'`,
        fields: {
          drop_id: 'e.drop_id',
          wave_id: 'c.wave_id',
          vote: 'r.real_time_rating',
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
        from: `${entries} join ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} lb on lb.entry_id=e.id and lb.competition_id=c.id left join ${COMPETITION_ENTRY_RUNTIME_TABLE} r on r.entry_id=e.id and r.competition_id=c.id where e.status='ACTIVE' and (cast(json_unquote(json_extract(c.decision_config,'$.time_lock_ms')) as signed)>0 or exists(select 1 from ${WAVE_LEADERBOARD_ENTRIES_TABLE} original where original.drop_id=e.drop_id and original.wave_id=c.wave_id))`,
        fields: {
          drop_id: 'e.drop_id',
          wave_id: 'c.wave_id',
          vote: 'lb.rating',
          vote_on_decision_time: 'coalesce(lb.decision_rating,lb.rating)',
          timestamp:
            'coalesce(lb.ordering_time,r.last_increased_at,e.submitted_at)',
          over_threshold_since_ms: 'r.over_threshold_since'
        }
      };
    case WAVES_DECISIONS_TABLE:
      return {
        from: `${owners} join ${COMPETITION_DECISIONS_TABLE} d on d.competition_id=c.id where ${nativePrimary} and d.status='COMPLETED'`,
        fields: { wave_id: 'c.wave_id', decision_time: 'd.scheduled_at' }
      };
    case WAVES_DECISION_WINNER_DROPS_TABLE:
      return {
        from: `${entries} join ${COMPETITION_DECISIONS_TABLE} d on d.competition_id=c.id and d.id=e.decision_id join ${COMPETITION_DECISION_WINNERS_TABLE} win on win.entry_id=e.id and win.decision_id=d.id`,
        fields: {
          wave_id: 'c.wave_id',
          decision_time: 'd.scheduled_at',
          drop_id: 'e.drop_id',
          ranking: 'win.rank',
          final_vote: 'win.final_rating',
          prizes: `coalesce((select json_arrayagg(a.award) over(order by a.outcome_position,a.id rows between unbounded preceding and unbounded following) from ${COMPETITION_OUTCOME_AWARDS_TABLE} a where a.competition_id=c.id and a.decision_id=d.id and a.entry_id=e.id limit 1),json_array())`
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
        from: `${owners} join ${COMPETITION_OUTCOMES_TABLE} o on o.competition_id=c.id join ${COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE} i on i.outcome_id=o.id and i.competition_id=c.id where ${nativePrimary}`,
        fields: {
          wave_id: 'c.wave_id',
          wave_outcome_position: 'o.position',
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

/** Additive schema, installed before any reader deployment or enrollment. */
export async function installLegacyCompetitionGetFacade(
  db: SqlExecutor
): Promise<void> {
  await withMigrationSchemaConnection(db, async ({ connection }) => {
    const options = { wrappedConnection: connection };
    for (const table of LEGACY_GET_SOURCE_TABLES) {
      const rows = await db.execute<{
        COLUMN_NAME: string;
        CHARACTER_SET_NAME: string | null;
        COLLATION_NAME: string | null;
      }>(
        'select COLUMN_NAME,CHARACTER_SET_NAME,COLLATION_NAME from information_schema.COLUMNS where TABLE_SCHEMA=database() and TABLE_NAME=:table order by ORDINAL_POSITION',
        { table },
        options
      );
      if (!rows.length)
        throw new Error('Compatibility source schema is missing');
      const columns = rows.map((row) => row.COLUMN_NAME);
      let select: string;
      if (table === WAVES_TABLE) {
        select = `select ${columns.map((column) => `${waveFields[column] ? `case when ${nativePrimary} then ${waveFields[column]} else w.\`${column}\` end` : `w.\`${column}\``} as \`${column}\``).join(',')} from ${WAVES_TABLE} w left join ${owners} on c.legacy_wave_id=w.id`;
      } else if (table === DROPS_TABLE) {
        select = `select ${columns.map((column) => `${column === 'drop_type' ? "case when e.status='WINNER' then 'WINNER' when e.status='ACTIVE' then 'PARTICIPATORY' when e.status in ('WITHDRAWN','DISQUALIFIED') then 'CHAT' when d.drop_type='COMPETITION' then 'CHAT' else d.drop_type end" : `d.\`${column}\``} as \`${column}\``).join(',')} from ${DROPS_TABLE} d left join ${COMPETITIONS_TABLE} c on c.legacy_wave_id=d.wave_id and ${nativePrimary} left join ${COMPETITION_ENTRIES_TABLE} e on e.competition_id=c.id and e.drop_id=d.id`;
      } else {
        const native = nativeSelects(table);
        if (columns.some((column) => !native.fields[column]))
          throw new Error(`Compatibility schema drift: ${table}`);
        select = `select ${columns.map((column) => `s.\`${column}\``).join(',')} from ${table} s where not exists (select 1 from ${owners} where c.legacy_wave_id=s.wave_id and ${nativePrimary}) union all select ${rows.map((row) => `${row.CHARACTER_SET_NAME ? `convert(${native.fields[row.COLUMN_NAME]} using ${row.CHARACTER_SET_NAME}) collate ${row.COLLATION_NAME}` : native.fields[row.COLUMN_NAME]} as \`${row.COLUMN_NAME}\``).join(',')} from ${native.from}`;
      }
      await db.execute(
        `create or replace sql security invoker view \`${legacyGetView(table)}\` as ${select}`,
        {},
        options
      );
    }
  });
}

/** Independent shadow projection on the comparison transaction only. */
export async function withLegacyShadowGetFacade<T>(
  db: SqlExecutor,
  id: string,
  ctx: { connection?: import('@/sql-executor').ConnectionWrapper<unknown> },
  action: () => Promise<T>
): Promise<T> {
  if (!ctx.connection)
    throw new Error('Shadow compatibility comparison requires a transaction');
  const options = { wrappedConnection: ctx.connection };
  await db.execute(
    `insert into ${COMPETITION_LEGACY_MIRROR_PERMITS_TABLE} (connection_id,competition_id,depth) values(connection_id(),:id,-1)`,
    { id },
    options
  );
  try {
    return await action();
  } finally {
    await db.execute(
      `delete from ${COMPETITION_LEGACY_MIRROR_PERMITS_TABLE} where connection_id=connection_id() and competition_id=:id and depth=-1`,
      { id },
      options
    );
  }
}
