import type { SqlExecutor } from '@/sql-executor';
import type { RequestContext } from '@/request.context';
import {
  COMPETITIONS_TABLE,
  WAVES_TABLE,
  WAVES_ARCHIVE_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  WAVE_VOTING_CREDIT_NFTS_ARCHIVE_TABLE
} from '@/constants';
import { withCompetitionSchemaConnection } from '@/competitions/competition-schema';
import { isCompetitionRuntimeRetired } from '@/competitions/competition-runtime-retirement-state';
import {
  CHAT_WAVE_COMPATIBILITY_DEFAULTS,
  RETIRED_WAVE_COMPETITION_COLUMNS
} from '@/competitions/legacy-competition-get-facade';
import {
  WAVE_HUB_PARTICIPATION_FIELDS,
  WAVE_HUB_VOTING_FIELDS
} from './wave-hub-configuration';

const prefix = 'temporary_wave_hub_configuration_';
const sources = [
  {
    table: WAVES_TABLE,
    key: 'id',
    child: WAVE_VOTING_CREDIT_NFTS_TABLE,
    childKey: 'wave_id'
  },
  {
    table: WAVES_ARCHIVE_TABLE,
    key: 'archive_id',
    child: WAVE_VOTING_CREDIT_NFTS_ARCHIVE_TABLE,
    childKey: 'wave_archive_id'
  }
] as const;
const booleanFields = new Set([
  'participation_signature_required',
  'voting_signature_required',
  'forbid_negative_votes'
]);
type Source = (typeof sources)[number];
type Trigger = {
  name: string;
  table: string;
  event: string;
  timing: string;
  body: string;
};

function eligible(alias: string) {
  return `${alias}.type='CHAT' and not exists(select 1 from ${COMPETITIONS_TABLE} c
    where c.legacy_wave_id=${alias}.id and c.legacy_wave_id=c.wave_id and c.storage_mode='NATIVE')`;
}

function creditNfts(source: Source, alias: string): string {
  const key =
    source.table === WAVES_TABLE ? `${alias}.id` : `${alias}.archive_id`;
  return `coalesce((select json_arrayagg(json_object('contract',n.contract,'token_id',n.token_id))
    over(order by n.contract,n.token_id rows between unbounded preceding and unbounded following)
    from ${source.child} n where n.${source.childKey}=${key} limit 1),json_array())`;
}

function configuration(
  source: Source,
  alias: string,
  kind: 'participation' | 'voting'
): string {
  const fields =
    kind === 'participation'
      ? WAVE_HUB_PARTICIPATION_FIELDS
      : WAVE_HUB_VOTING_FIELDS;
  const pairs = Object.entries(fields).map(
    ([column, field]) =>
      `'${field}',${booleanFields.has(column) ? `cast(if(${alias}.${column},'true','false') as json)` : `${alias}.${column}`}`
  );
  if (kind === 'voting')
    pairs.push(`'credit_nfts',${creditNfts(source, alias)}`);
  return `json_object(${pairs.join(',')})`;
}

function parentTrigger(source: Source, event: 'INSERT' | 'UPDATE'): Trigger {
  const statements = (['participation', 'voting'] as const).map((kind) => {
    const column = `hub_${kind}_config`;
    const expected = configuration(source, 'NEW', kind);
    const fields =
      kind === 'participation'
        ? WAVE_HUB_PARTICIPATION_FIELDS
        : WAVE_HUB_VOTING_FIELDS;
    const nativeWrite = `NEW.${column} is not null${event === 'UPDATE' ? ` and not(NEW.${column}<=>OLD.${column})` : ''}`;
    const numberFields = new Set([
      'max_entries_per_participant',
      'starts_at',
      'ends_at',
      'max_votes_per_identity_to_entry',
      'time_lock_ms'
    ]);
    const mirror = Object.entries(fields)
      .map(([target, field]) => {
        const raw = `json_extract(NEW.${column},'$.${field}')`;
        const text = `case when json_type(${raw})='NULL' then null else json_unquote(${raw}) end`;
        const value = booleanFields.has(target)
          ? `case ${text} when 'true' then 1 when 'false' then 0 else cast(${text} as signed) end`
          : numberFields.has(field)
            ? `cast(${text} as signed)`
            : field === 'required_metadata' || field === 'required_media'
              ? raw
              : text;
        return `set NEW.${target}=${value};`;
      })
      .join('\n');
    const changed =
      event === 'UPDATE'
        ? ` or (NEW.${column}<=>OLD.${column}) and not(${expected}<=>${configuration(source, 'OLD', kind)})`
        : '';
    return `if ${nativeWrite} then
        if not(json_type(NEW.${column})<=>'OBJECT') then
          signal sqlstate '45000' set message_text='Native hub configuration must be an object'; end if;
        ${mirror}
      elseif NEW.${column} is null${changed} then set NEW.${column}=${expected}; end if;
      if not(json_type(NEW.${column})<=>'OBJECT') then
        signal sqlstate '45000' set message_text='Native hub configuration must be an object'; end if;`;
  });
  return {
    name: `${prefix}${source.table === WAVES_TABLE ? 'wave' : 'archive'}_${event.toLowerCase()}`,
    table: source.table,
    event,
    timing: 'BEFORE',
    body: `begin if ${eligible('NEW')} then ${statements.join('\n')} end if; end`
  };
}

function childTrigger(
  source: Source,
  event: 'INSERT' | 'UPDATE' | 'DELETE'
): Trigger {
  const row = event === 'DELETE' ? 'OLD' : 'NEW';
  const key = source.table === WAVES_TABLE ? 'id' : 'archive_id';
  const foreignKey =
    source.table === WAVES_TABLE ? 'wave_id' : 'wave_archive_id';
  const keys =
    event === 'UPDATE'
      ? `OLD.${foreignKey},NEW.${foreignKey}`
      : `${row}.${foreignKey}`;
  return {
    name: `${prefix}${source.table === WAVES_TABLE ? 'nft' : 'archive_nft'}_${event.toLowerCase()}`,
    table: source.child,
    event,
    timing: 'AFTER',
    body: `begin update ${source.table} p set p.hub_voting_config=json_set(
      coalesce(p.hub_voting_config,${configuration(source, 'p', 'voting')}),'$.credit_nfts',${creditNfts(source, 'p')})
      where p.${key} in (${keys}) and ${eligible('p')} order by p.${key}; end`
  };
}

const triggers: Trigger[] = sources.flatMap((source) => [
  parentTrigger(source, 'INSERT'),
  parentTrigger(source, 'UPDATE'),
  childTrigger(source, 'INSERT'),
  childTrigger(source, 'UPDATE'),
  childTrigger(source, 'DELETE')
]);

async function installedCapture(
  db: SqlExecutor,
  connection: NonNullable<RequestContext['connection']>
) {
  const rows = await db.execute<{
    name: string;
    table_name: string;
    event: string;
    timing: string;
    body: string;
  }>(
    `select TRIGGER_NAME as name,EVENT_OBJECT_TABLE as table_name,EVENT_MANIPULATION as event,
    ACTION_TIMING as timing,ACTION_STATEMENT as body from information_schema.TRIGGERS
    where TRIGGER_SCHEMA=database() and TRIGGER_NAME like :pattern`,
    { pattern: `${prefix}%` },
    { wrappedConnection: connection }
  );
  for (const row of rows) {
    const expected = triggers.find((trigger) => trigger.name === row.name);
    if (
      !expected ||
      expected.table !== row.table_name ||
      expected.event !== row.event ||
      expected.timing !== row.timing ||
      expected.body.replace(/\s+/g, ' ').trim() !==
        row.body.replace(/\s+/g, ' ').trim()
    )
      throw new Error(
        'Unrecognized temporary shared-hub configuration capture'
      );
  }
  return rows;
}

async function installCapture(db: SqlExecutor) {
  return withCompetitionSchemaConnection(db, async ({ connection }) => {
    const existing = await installedCapture(db, connection);
    for (const trigger of triggers) {
      if (existing.some((row) => row.name === trigger.name)) continue;
      await db.execute(
        `create trigger \`${trigger.name}\` ${trigger.timing} ${trigger.event}
        on \`${trigger.table}\` for each row ${trigger.body}`,
        {},
        { wrappedConnection: connection }
      );
    }
    return triggers.length;
  });
}

export type WaveHubConfigurationPreparationOptions = {
  readonly batchSize?: number;
  readonly onBatch?: (progress: {
    table: 'waves' | 'waves_archive';
    rows: number;
  }) => Promise<void>;
};

export async function prepareWaveHubConfiguration(
  db: SqlExecutor,
  options: WaveHubConfigurationPreparationOptions = {}
): Promise<{ waves: number; archives: number; capture_triggers: number }> {
  if (await isCompetitionRuntimeRetired(db))
    throw new Error(
      'Competition runtime is retired; shared-hub source preparation is no longer permitted'
    );
  const batchSize = options.batchSize ?? 1000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error(
      'Shared-hub configuration batch size must be between 1 and 1000'
    );
  const count = await installCapture(db);
  for (const source of sources) {
    let after: string | null = null;
    while (true) {
      const rows = await db.executeNativeQueriesInTransaction(
        async (connection) => {
          const selected = await db.execute<{ row_key: string }>(
            `select cast(s.${source.key} as char) as row_key from ${source.table} s
           where ${eligible('s')} and (:after is null or s.${source.key}>:after)
           order by s.${source.key} limit :batchSize for update`,
            { after, batchSize },
            { wrappedConnection: connection }
          );
          if (selected.length)
            await db.execute(
              `update ${source.table} s set
          s.hub_participation_config=coalesce(s.hub_participation_config,${configuration(source, 's', 'participation')}),
          s.hub_voting_config=coalesce(s.hub_voting_config,${configuration(source, 's', 'voting')})
          where s.${source.key} in (:keys)`,
              { keys: selected.map((row) => row.row_key) },
              { wrappedConnection: connection }
            );
          return selected;
        }
      );
      if (!rows.length) break;
      after = rows[rows.length - 1].row_key;
      await options.onBatch?.({ table: source.table, rows: rows.length });
      if (rows.length < batchSize) break;
    }
  }
  return {
    ...(await assertWaveHubConfigurationParity(db)),
    capture_triggers: count
  };
}

function parityFields(source: Source) {
  const checks = Object.entries(WAVE_HUB_PARTICIPATION_FIELDS).map(
    ([column, field]) => ({
      field: column,
      mismatch: `not(json_extract(s.hub_participation_config,'$.${field}')<=>json_extract(${configuration(source, 's', 'participation')},'$.${field}'))`
    })
  );
  checks.push(
    ...Object.entries(WAVE_HUB_VOTING_FIELDS).map(([column, field]) => ({
      field: column,
      mismatch: `not(json_extract(s.hub_voting_config,'$.${field}')<=>json_extract(${configuration(source, 's', 'voting')},'$.${field}'))`
    }))
  );
  checks.push({
    field: 'credit_nfts',
    mismatch: `not(json_extract(s.hub_voting_config,'$.credit_nfts')<=>${creditNfts(source, 's')})`
  });
  const owned = new Set<string>([
    ...Object.keys(WAVE_HUB_PARTICIPATION_FIELDS),
    ...Object.keys(WAVE_HUB_VOTING_FIELDS)
  ]);
  for (const column of RETIRED_WAVE_COMPETITION_COLUMNS) {
    if (
      owned.has(column) ||
      column === 'type' ||
      (source.table === WAVES_ARCHIVE_TABLE && column === 'next_decision_time')
    )
      continue;
    checks.push({
      field: column,
      // The existing API parses SQL NULL and JSON null to the same null strategy.
      // Other JSON values must still fail instead of losing visible configuration.
      mismatch:
        column === 'decisions_strategy'
          ? `not(s.\`${column}\` is null or json_type(s.\`${column}\`)='NULL')`
          : `not(s.\`${column}\`<=>${CHAT_WAVE_COMPATIBILITY_DEFAULTS[column] ?? 'null'})`
    });
  }
  return checks;
}

export async function assertWaveHubConfigurationParity(
  db: SqlExecutor
): Promise<{ waves: number; archives: number }> {
  const counts = { waves: 0, archives: 0 };
  const errors: {
    table: string;
    is_direct_message: number | null;
    field: string;
    count: number;
  }[] = [];
  for (const source of sources) {
    const checks = parityFields(source);
    const rows = await db.execute<Record<string, number | string | null>>(
      `select s.is_direct_message,count(*) as total,${checks.map((check, index) => `sum(${check.mismatch}) as f${index}`).join(',')}
       from ${source.table} s where ${eligible('s')} group by s.is_direct_message`,
      {}
    );
    for (const row of rows) {
      counts[source.table === WAVES_TABLE ? 'waves' : 'archives'] += Number(
        row.total
      );
      checks.forEach((check, index) => {
        if (Number(row[`f${index}`]))
          errors.push({
            table: source.table,
            is_direct_message:
              row.is_direct_message === null
                ? null
                : Number(row.is_direct_message),
            field: check.field,
            count: Number(row[`f${index}`])
          });
      });
    }
  }
  if (errors.length)
    throw new Error(
      `Native shared-hub configuration parity failed: ${JSON.stringify(errors)}`
    );
  return counts;
}

export async function finalizeWaveHubConfigurationCapture(
  db: SqlExecutor
): Promise<{ disabled_triggers: number }> {
  if (!(await isCompetitionRuntimeRetired(db)))
    throw new Error(
      'Switch native competition views before finalizing shared-hub capture'
    );
  await assertNativeConfigurationShapes(db);
  const disabled = await withCompetitionSchemaConnection(
    db,
    async ({ connection }) => {
      const installed = await installedCapture(db, connection);
      for (const trigger of installed)
        await db.execute(
          `drop trigger if exists \`${trigger.name}\``,
          {},
          { wrappedConnection: connection }
        );
      return installed.length;
    }
  );
  return { disabled_triggers: disabled };
}

async function assertNativeConfigurationShapes(db: SqlExecutor) {
  const errors: { table: string; field: string; count: number }[] = [];
  for (const source of sources) {
    const checks: { field: string; mismatch: string }[] = [];
    for (const kind of ['participation', 'voting'] as const) {
      const column = `hub_${kind}_config`;
      const fields = Object.values(
        kind === 'participation'
          ? WAVE_HUB_PARTICIPATION_FIELDS
          : WAVE_HUB_VOTING_FIELDS
      );
      const required = kind === 'voting' ? [...fields, 'credit_nfts'] : fields;
      checks.push({
        field: column,
        mismatch: `not(coalesce(json_type(s.${column})='OBJECT',false))`
      });
      for (const field of required)
        checks.push({
          field: `${column}.${field}`,
          mismatch: `not(coalesce(json_contains_path(s.${column},'one','$.${field}'),false))`
        });
      for (const field of kind === 'participation'
        ? ['required_metadata', 'required_media']
        : ['credit_nfts'])
        checks.push({
          field: `${column}.${field}`,
          mismatch: `not(coalesce(json_type(json_extract(s.${column},'$.${field}'))='ARRAY',false))`
        });
    }
    const predicate =
      source.table === WAVES_TABLE
        ? `not exists(select 1 from ${COMPETITIONS_TABLE} c where c.legacy_wave_id=s.id and c.legacy_wave_id=c.wave_id and c.storage_mode='NATIVE')`
        : '(s.hub_participation_config is not null or s.hub_voting_config is not null)';
    const [row] = await db.execute<Record<string, number | string | null>>(
      `select ${checks.map((check, index) => `sum(${check.mismatch}) as f${index}`).join(',')} from ${source.table} s where ${predicate}`,
      {}
    );
    checks.forEach((check, index) => {
      if (Number(row[`f${index}`]))
        errors.push({
          table: source.table,
          field: check.field,
          count: Number(row[`f${index}`])
        });
    });
  }
  if (errors.length)
    throw new Error(
      `Native shared-hub configuration is incomplete: ${JSON.stringify(errors)}`
    );
}
