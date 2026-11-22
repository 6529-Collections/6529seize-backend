import { AppFeatures, appFeatures } from '@/app-features';
import {
  PROFILE_CMS_AGENT_EVENTS_TABLE,
  PROFILE_CMS_AGENT_GRANTS_TABLE,
  PROFILE_CMS_AGENT_PROPOSALS_TABLE,
  PROFILE_CMS_CHAIN_HEADS_TABLE,
  PROFILE_CMS_PACKAGES_TABLE,
  PROFILE_CMS_POINTER_EVENTS_TABLE,
  PROFILE_CMS_PUBLISH_SIGNATURES_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { deviceGrantProofSource } from '@/signed-records/record-grants';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import { RecordLogWriter } from '@/signed-records/record-log/record-log.service';
import { Time } from '@/time';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

/**
 * The rows 6529.io's own profile site path writes, in the interim record
 * log's private chain (sealed to 6529.io's provider keys): drafts and other
 * package rows, the pointer events and publish signatures it writes, and
 * the BYO agent grants, proposals and events. The chain follower's writes
 * are not logged; a rebuild gets them from the chain. Each write appends
 * the row as it stands after the write, as a service entry of lane
 * `publish`, in the
 * write's own transaction, stamped with the chain change the profile site
 * index had last applied for that profile (height and document version).
 * Replaying the entries in log order, each right after that change, rebuilds
 * the rows.
 */
export const PROFILE_CMS_LOG_LANE = 'publish';

export const PROFILE_CMS_PRIVATE_KINDS = {
  'cms.package': { table: PROFILE_CMS_PACKAGES_TABLE, key: 'id' },
  'cms.agent-grant': { table: PROFILE_CMS_AGENT_GRANTS_TABLE, key: 'id' },
  'cms.agent-proposal': { table: PROFILE_CMS_AGENT_PROPOSALS_TABLE, key: 'id' },
  'cms.agent-event': { table: PROFILE_CMS_AGENT_EVENTS_TABLE, key: 'id' },
  'cms.pointer-event': { table: PROFILE_CMS_POINTER_EVENTS_TABLE, key: 'id' },
  'cms.publish-signature': {
    table: PROFILE_CMS_PUBLISH_SIGNATURES_TABLE,
    key: 'id'
  }
} as const;

export type ProfileCmsPrivateKind = keyof typeof PROFILE_CMS_PRIVATE_KINDS;

/** The body of one lane `publish` service entry. */
export interface ProfileCmsPrivateEntry {
  readonly v: 1;
  readonly kind: ProfileCmsPrivateKind;
  /** When the write happened, ms. */
  readonly at: number;
  /**
   * The last chain change the profile site index had applied for the row's
   * profile when the row was written: its height and document version; both
   * null when none yet. A rebuild replays the entry after that change and
   * before the profile's next one. (Wall time can't order it: a change's
   * block time comes before the index applies it. The version tells apart
   * two changes of one person in one block.)
   */
  readonly height: number | null;
  readonly doc_version: number | null;
  /** The row's columns after the write, as MySQL returns them. */
  readonly row: Record<string, unknown>;
}

const COLUMN_PATTERN = /^[a-z0-9_]{1,64}$/;

export class ProfileCmsPrivateLog extends LazyDbAccessCompatibleService {
  constructor(
    supplier = dbSupplier,
    // The same writer as `recordLog`, built here without the segment
    // poster's imports, since the profile CMS tables' own classes load this.
    private readonly writer: Pick<
      RecordLogWriter,
      'append'
    > = new RecordLogWriter(recordLogDb, deviceGrantProofSource),
    private readonly features: Pick<
      AppFeatures,
      'isProfileCmsPersonalLogEnabled'
    > = appFeatures,
    private readonly now: () => number = () => Time.currentMillis()
  ) {
    super(supplier);
  }

  /**
   * Runs `write` and appends the rows it wrote in one transaction: the
   * caller's, or a new one when the log is on and the caller has none. A
   * failed append then undoes the write, so no write goes unlogged. With the
   * flag off it only runs `write`.
   */
  async logged(
    ctx: RequestContext,
    rows: readonly (readonly [ProfileCmsPrivateKind, string])[],
    write: (ctx: RequestContext) => Promise<unknown>
  ): Promise<void> {
    if (ctx.connection || !this.features.isProfileCmsPersonalLogEnabled()) {
      await write(ctx);
      for (const [kind, id] of rows) {
        await this.rowWritten(kind, id, ctx);
      }
      return;
    }
    await this.executeNativeQueriesInTransaction(async (connection) => {
      const txCtx: RequestContext = { ...ctx, connection };
      await write(txCtx);
      for (const [kind, id] of rows) {
        await this.rowWritten(kind, id, txCtx);
      }
    });
  }

  /** Appends the row as it stands now. Does nothing with the flag off. */
  async rowWritten(
    kind: ProfileCmsPrivateKind,
    id: string,
    ctx: RequestContext
  ): Promise<void> {
    if (!this.features.isProfileCmsPersonalLogEnabled()) {
      return;
    }
    const { table, key } = PROFILE_CMS_PRIVATE_KINDS[kind];
    const options = ctx.connection
      ? { wrappedConnection: ctx.connection }
      : undefined;
    const rows = await this.db.execute<Record<string, unknown>>(
      `select * from ${table} where ${key} = :id`,
      { id },
      options
    );
    if (!rows[0]) {
      return;
    }
    // Read in the write's transaction: a chain change the index applies to
    // this profile after it commits replays after this entry.
    const heads = await this.db.execute<{
      height: number | string;
      doc_version: number | string;
    }>(
      `select height, doc_version from ${PROFILE_CMS_CHAIN_HEADS_TABLE}
       where profile_id = :profileId
       order by height desc, doc_version desc
       limit 1`,
      { profileId: rows[0].profile_id },
      options
    );
    const head = heads[0];
    const body: ProfileCmsPrivateEntry = {
      v: 1,
      kind,
      at: this.now(),
      height: head ? Number(head.height) : null,
      doc_version: head ? Number(head.doc_version) : null,
      row: jsonRow(rows[0])
    };
    await this.writer.append(
      [
        {
          t: 'entry',
          lane: PROFILE_CMS_LOG_LANE,
          chain: 'private',
          body: body as unknown as Record<string, unknown>
        }
      ],
      ctx
    );
  }

  /**
   * Once, after FEATURE_PROFILE_CMS_PERSONAL_LOG is on for the API (command
   * `profile-cms:log-existing-rows`): appends every row the logged tables
   * hold now, so state from before the log is in it. Writes from the moment
   * the flag is on are logged already; a row logged twice replays as it
   * stood the second time. Returns the number of rows logged.
   */
  async logExistingRows(ctx: RequestContext): Promise<number> {
    if (!this.features.isProfileCmsPersonalLogEnabled()) {
      throw new Error(
        'Turn FEATURE_PROFILE_CMS_PERSONAL_LOG on before logging existing rows'
      );
    }
    let logged = 0;
    for (const kind of Object.keys(
      PROFILE_CMS_PRIVATE_KINDS
    ) as ProfileCmsPrivateKind[]) {
      const { table, key } = PROFILE_CMS_PRIVATE_KINDS[kind];
      const rows = await this.db.execute<{ id: string }>(
        `select ${key} as id from ${table} order by ${key}`,
        {},
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
      for (const row of rows) {
        await this.rowWritten(kind, row.id, ctx);
        logged++;
      }
    }
    return logged;
  }

  /** Writes a logged row back, replacing what the table holds for its key. */
  async applyEntry(
    entry: ProfileCmsPrivateEntry,
    ctx: RequestContext
  ): Promise<void> {
    const kind = PROFILE_CMS_PRIVATE_KINDS[entry.kind];
    if (!kind) {
      throw new Error(`Unknown profile site log entry ${String(entry.kind)}`);
    }
    // Column names are ASCII: code-unit order is byte order.
    const columns = Object.keys(entry.row).sort((left, right) =>
      left < right ? -1 : Number(left > right)
    );
    if (
      !columns.includes(kind.key) ||
      !columns.every((c) => COLUMN_PATTERN.test(c))
    ) {
      throw new Error(`Malformed profile site log entry of ${entry.kind}`);
    }
    const params = Object.fromEntries(
      columns.map((column) => [column, toParam(entry.row[column])])
    );
    await this.db.execute(
      `insert into ${kind.table} (${columns.map((c) => `\`${c}\``).join(', ')})
       values (${columns.map((c) => `:${c}`).join(', ')})
       on duplicate key update ${columns
         .filter((c) => c !== kind.key)
         .map((c) => `\`${c}\` = values(\`${c}\`)`)
         .join(', ')}`,
      params,
      ctx.connection ? { wrappedConnection: ctx.connection } : undefined
    );
  }
}

/** Reads a lane `publish` service entry body; null for anything else. */
export function readProfileCmsPrivateEntry(
  body: unknown
): ProfileCmsPrivateEntry | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { v, kind, at, height, doc_version, row } = body as Record<
    string,
    unknown
  >;
  if (
    v !== 1 ||
    typeof kind !== 'string' ||
    !Object.prototype.hasOwnProperty.call(PROFILE_CMS_PRIVATE_KINDS, kind) ||
    typeof at !== 'number' ||
    !(height === null || Number.isSafeInteger(height)) ||
    !(doc_version === null || Number.isSafeInteger(doc_version)) ||
    (height === null) !== (doc_version === null) ||
    typeof row !== 'object' ||
    row === null ||
    Array.isArray(row)
  ) {
    return null;
  }
  return {
    v: 1,
    kind: kind as ProfileCmsPrivateKind,
    at,
    height: height as number | null,
    doc_version: doc_version as number | null,
    row: row as Record<string, unknown>
  };
}

/** Column values as canonical JSON can carry them: JSON columns stay strings. */
function jsonRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [column, jsonValue(value)])
  );
}

function jsonValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

function toParam(value: unknown): unknown {
  return typeof value === 'object' && value !== null
    ? JSON.stringify(value)
    : value;
}

export const profileCmsPrivateLog = new ProfileCmsPrivateLog();
