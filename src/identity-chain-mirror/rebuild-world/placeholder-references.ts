import { probeProfileId } from '@/rebuild/run/probe-fixture.steps';
import { dbSupplier, SqlExecutor } from '@/sql-executor';
import { IDENTITY_WORLD_PLACEHOLDER_IDS } from './world-ids';

/**
 * One row of each kind of reference to a placeholder profile that the
 * identity export leaves out: each table and column of 6529.io's that names
 * a profile, naming the world's untaken placeholder. The identity rebuild
 * restores that profile; these rows show the references still find it.
 * Each kind is provisional: how many such references 6529.io holds is not
 * counted yet, and the counts will say which kinds matter.
 *
 * Not planted here:
 * - ratings given and received: the mirror writes the ratings table whole
 *   from the chain, where a profile with no chain identity has none (the
 *   bulk REP removal leaves no rating by or of them);
 * - TDH on their identities rows: the world's second untaken placeholder
 *   holds TDH (site-rows.ts);
 * - profile activity logs and the latest-log row: the site's code writes
 *   them for each placeholder it makes (bulkCreateIdentities);
 * - encrypted DM devices, group memberships and messages: the DM area
 *   rebuilds those tables only from its relay records, so a row put in
 *   beside them could never come back and would show nothing about the
 *   placeholder; and its seed publishes events shaped by the rows it
 *   finds, which its recorded relay then refuses.
 *
 * Each row sets its reference column to the placeholder's profile id and
 * the columns in `set`; any other column that needs a value gets a plain
 * one by its type (the schema's own column list), so a row stands for its
 * kind whatever else the table holds. The other profile in a pair is the
 * probes' signed-in caller, whose views the site probes read, but for a
 * mute or block of the placeholder, which is the other probe identity's.
 * Both are the world's actors, named by the world's fixed ids
 * (probeProfileId), which identity.actors-check proves the world holds
 * before this seed runs.
 */

const PLACEHOLDER = IDENTITY_WORLD_PLACEHOLDER_IDS.untaken;

/** A probe identity in a row: its profile id, filled in when planting. */
export interface ProbeProfile {
  readonly probe: 1 | 2;
}
/** The probes' profile ids, by probe. */
export type ProbeProfileIds = Readonly<Record<1 | 2, string>>;

const CALLER: ProbeProfile = { probe: 1 };
/**
 * The one who mutes and blocks it: not the caller, whose notification that
 * names it a mute or block of theirs would hide.
 */
const OTHER: ProbeProfile = { probe: 2 };

const isProbeProfile = (value: unknown): value is ProbeProfile =>
  value !== null && typeof value === 'object' && 'probe' in value;
/** A fixed time for the rows that need one. */
const AT_MS = 1_763_500_000_000;
const AT = '2025-11-18 21:06:40';

export interface PlaceholderReference {
  readonly kind: string;
  readonly table: string;
  readonly column: string;
  readonly set?: Readonly<Record<string, unknown>>;
}

export const PLACEHOLDER_REFERENCES: readonly PlaceholderReference[] = [
  {
    kind: 'Follows they made',
    table: 'identity_subscriptions',
    column: 'subscriber_id',
    set: {
      target_id: CALLER,
      target_type: 'IDENTITY',
      target_action: 'DROP_CREATED'
    }
  },
  {
    kind: 'Follows of them',
    table: 'identity_subscriptions',
    column: 'target_id',
    set: {
      subscriber_id: CALLER,
      target_type: 'IDENTITY',
      target_action: 'DROP_CREATED'
    }
  },
  {
    kind: 'Mutes they made',
    table: 'identity_mutes',
    column: 'muter_id',
    set: { muted_identity_id: CALLER }
  },
  {
    kind: 'Mutes of them',
    table: 'identity_mutes',
    column: 'muted_identity_id',
    set: { muter_id: OTHER }
  },
  {
    kind: 'Notifications to them',
    table: 'identity_notifications',
    column: 'identity_id',
    set: {
      additional_identity_id: CALLER,
      cause: 'IDENTITY_SUBSCRIBED',
      additional_data: '{}',
      created_at: AT_MS
    }
  },
  {
    kind: 'Notifications naming them',
    table: 'identity_notifications',
    column: 'additional_identity_id',
    set: {
      identity_id: CALLER,
      cause: 'IDENTITY_SUBSCRIBED',
      additional_data: '{}',
      created_at: AT_MS
    }
  },
  {
    kind: 'Drop reactions',
    table: 'drop_reactions',
    column: 'profile_id'
  },
  {
    kind: 'Drop bookmarks',
    table: 'drop_bookmarks',
    column: 'identity_id'
  },
  {
    kind: 'Poll votes',
    table: 'drop_poll_votes',
    column: 'voter_id'
  },
  {
    kind: 'Quick-vote skips',
    table: 'drop_quickvote_skips',
    column: 'identity_id'
  },
  {
    kind: 'Push devices',
    table: 'push_notification_devices',
    column: 'profile_id'
  },
  {
    kind: 'Push settings',
    table: 'push_notification_settings',
    column: 'profile_id'
  },
  {
    kind: 'Profile preferences',
    table: 'profile_preferences',
    column: 'profile_id'
  },
  {
    kind: 'Pinned waves',
    table: 'pinned_waves',
    column: 'profile_id'
  },
  {
    kind: 'EULA consents',
    table: 'eula_consent',
    column: 'profile_id'
  },
  {
    kind: 'Mention alias memberships',
    table: 'mention_alias_members',
    column: 'member_profile_id'
  },
  {
    kind: 'Artist artwork alerts',
    table: 'artist_artwork_alerts',
    column: 'subscriber_id'
  },
  {
    kind: 'Wave group notification subscriptions',
    table: 'wave_group_notification_subscriptions',
    column: 'identity_id'
  },
  {
    kind: 'Moderation blocks they made',
    table: 'content_moderation_profile_blocks',
    column: 'blocker_profile_id',
    set: { blocked_profile_id: CALLER }
  },
  {
    kind: 'Moderation blocks of them',
    table: 'content_moderation_profile_blocks',
    column: 'blocked_profile_id',
    set: { blocker_profile_id: OTHER }
  },
  {
    kind: 'Moderation reports they made',
    table: 'content_moderation_reports',
    column: 'reporter_profile_id'
  },
  {
    kind: 'Attachments they own',
    table: 'attachments',
    column: 'owner_profile_id'
  },
  {
    kind: 'Media uploads',
    table: 'drop_media_uploads',
    column: 'profile_id'
  },
  {
    kind: 'Profile sites',
    table: 'cms_sites',
    column: 'owner_profile_id'
  },
  {
    kind: 'Proxies they created',
    table: 'profile_proxies',
    column: 'created_by',
    set: { target_id: CALLER, created_at: AT_MS }
  },
  {
    kind: 'Proxies naming them',
    table: 'profile_proxies',
    column: 'target_id',
    set: { created_by: CALLER, created_at: AT_MS }
  },
  {
    kind: 'xTDH grants they made (retired)',
    table: 'xtdh_grants',
    column: 'grantor_id'
  }
];

/** The tables the planted rows go into. */
export const PLACEHOLDER_REFERENCE_TABLES = Array.from(
  new Set(PLACEHOLDER_REFERENCES.map((it) => it.table))
);

interface ColumnInfo {
  readonly name: string;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly autoIncrement: boolean;
  readonly dataType: string;
  readonly columnType: string;
  readonly maxLength: number | null;
}

/**
 * A plain value of a column's type: `plant-` and the row's tag for text
 * (so two rows of a table differ in their key), 0, a fixed time, an empty
 * JSON object or the first value of an enum.
 */
export function plainValueOf(column: ColumnInfo, tag: string): unknown {
  const type = column.dataType.toLowerCase();
  if (type === 'enum') {
    const first = /^enum\('((?:[^']|'')*)'/i.exec(column.columnType);
    return first ? first[1].replace(/''/g, "'") : '';
  }
  if (type === 'json') return '{}';
  if (['datetime', 'timestamp'].includes(type)) return AT;
  if (type === 'date') return AT.slice(0, 10);
  if (/(char|text)$/.test(type)) {
    const value = `plant-${tag}`;
    return column.maxLength ? value.slice(0, column.maxLength) : value;
  }
  if (/(blob|binary)$/.test(type)) return Buffer.alloc(0);
  return 0;
}

/** A row of one reference, given its table's columns and the row's tag. */
export function referenceRowOf(
  reference: PlaceholderReference,
  columns: readonly ColumnInfo[],
  tag: string,
  probes: ProbeProfileIds
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    ...Object.fromEntries(
      Object.entries(reference.set ?? {}).map(([name, value]) => [
        name,
        isProbeProfile(value) ? probes[value.probe] : value
      ])
    ),
    [reference.column]: PLACEHOLDER
  };
  for (const column of columns) {
    if (
      column.name in row ||
      column.nullable ||
      column.hasDefault ||
      column.autoIncrement
    ) {
      continue;
    }
    row[column.name] = plainValueOf(column, tag);
  }
  return row;
}

async function columnsOf(
  db: SqlExecutor,
  table: string
): Promise<ColumnInfo[]> {
  const rows = await db.execute<{
    name: string;
    nullable: string;
    column_default: unknown;
    extra: string;
    data_type: string;
    column_type: string;
    max_length: number | string | null;
  }>(
    `select column_name as name, is_nullable as nullable,
            column_default as column_default, extra as extra,
            data_type as data_type, column_type as column_type,
            character_maximum_length as max_length
     from information_schema.columns
     where table_schema = database() and table_name = :table
     order by ordinal_position`,
    { table }
  );
  return rows.map((it) => ({
    name: it.name,
    nullable: it.nullable === 'YES',
    hasDefault: it.column_default !== null,
    autoIncrement: /auto_increment/i.test(it.extra ?? ''),
    dataType: it.data_type,
    columnType: it.column_type,
    maxLength: it.max_length === null ? null : Number(it.max_length)
  }));
}

/**
 * Plants one row of each kind, tagged by its place in the list. A table
 * or column the schema doesn't have fails the step, so the list and the
 * schema agree.
 */
export async function plantPlaceholderReferences(
  db: SqlExecutor = dbSupplier(),
  probes?: ProbeProfileIds
): Promise<number> {
  const probeIds: ProbeProfileIds = probes ?? {
    1: probeProfileId(1),
    2: probeProfileId(2)
  };
  let planted = 0;
  for (let i = 0; i < PLACEHOLDER_REFERENCES.length; i++) {
    const reference = PLACEHOLDER_REFERENCES[i];
    const columns = await columnsOf(db, reference.table);
    if (!columns.length) {
      throw new Error(
        `${reference.kind}: no table ${reference.table} in the schema`
      );
    }
    if (!columns.some((it) => it.name === reference.column)) {
      throw new Error(
        `${reference.kind}: no column ${reference.table}.${reference.column}`
      );
    }
    const row = referenceRowOf(reference, columns, String(i + 1), probeIds);
    const names = Object.keys(row);
    const params: Record<string, unknown> = {};
    names.forEach((name, n) => (params[`v${n}`] = row[name]));
    await db.execute(
      `insert into ${reference.table} (${names.map((it) => `\`${it}\``).join(', ')})
       values (${names.map((_, n) => `:v${n}`).join(', ')})`,
      params
    );
    planted++;
  }
  return planted;
}
