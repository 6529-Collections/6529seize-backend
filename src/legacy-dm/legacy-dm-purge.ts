import {
  ATTACHMENTS_TABLE,
  DROP_ATTACHMENTS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_MEDIA_UPLOADS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  PUSH_NOTIFICATION_CANCELLATIONS_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_METRICS_TABLE,
  WAVES_TABLE
} from '@/constants';
import {
  DESCRIPTION_DROP_KEPT_TABLES,
  DM_DESCRIPTION_DEFAULT_CONTENT,
  DM_WAVES_SQL,
  DOCUMENTATION_IMPORTS_SQL,
  WAVES_WITH_OPEN_REPORTS_SQL,
  INCONSISTENT_DM_WAVES_SQL,
  LEGACY_DM_BLOCKERS,
  LEGACY_DM_DROP_ID_TABLES,
  LEGACY_DM_DROP_STEPS,
  LEGACY_DM_WAVE_STEPS,
  NOTIFICATIONS_FOR_DROPS,
  type LegacyDmDropStep
} from './legacy-dm-purge.inventory';

/**
 * The D146 deletion of unencrypted DM content. Two modes:
 *
 * - `planLegacyDmPurge` (dry run) issues only SELECTs and returns counts.
 * - `executeLegacyDmPurge` deletes, one DM wave at a time, in bounded
 *   transactions of at most `batchSize` drops. It refuses before the cutoff
 *   and while any blocker exists. Re-running continues where it stopped:
 *   every step selects what is left, so the job is idempotent.
 *
 * Media bytes live in S3 and IPFS, not in these tables. Each batch hands the
 * media it is about to unlink to `onMedia` before deleting, so the operator
 * can write a manifest that `legacy-dm-media.ts` deletes from afterwards.
 */

/** Minimal SQL access: `?` placeholders, arrays expand to lists (mysql2). */
export interface LegacyDmSql {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<T[]>;
  /** Runs a mutating statement and returns the affected row count. */
  execute(sql: string, params?: readonly unknown[]): Promise<number>;
}

export interface LegacyDmDb extends LegacyDmSql {
  inTransaction<T>(work: (tx: LegacyDmSql) => Promise<T>): Promise<T>;
}

export type LegacyDmMediaEntry =
  | { readonly kind: 'drop_media_url'; readonly url: string }
  | {
      readonly kind: 'upload_object';
      readonly bucket: string | null;
      readonly key: string;
      readonly role: 'public' | 'ingest';
    }
  | {
      readonly kind: 'attachment_object';
      readonly attachmentId: string;
      readonly bucket: string | null;
      readonly key: string;
    }
  | {
      readonly kind: 'attachment_ipfs';
      readonly attachmentId: string;
      readonly cid: string;
    };

export interface LegacyDmPlan {
  readonly dmWaves: number;
  readonly inconsistentWaves: number;
  readonly drops: number;
  readonly descriptionDropsToReset: number;
  /** Authors' own imports of DM drops into artwork documentation (kept). */
  readonly documentationImports: number;
  /**
   * DM waves with an open moderation report: a signal, not a hold. Trust
   * and safety confirm whether any of them is under a legal hold.
   */
  readonly wavesWithOpenReports: number;
  readonly blockers: Record<string, number>;
  readonly rows: Record<string, number>;
  readonly media: {
    readonly dropMediaUrls: number;
    readonly uploadObjects: number;
    readonly attachments: number;
    readonly attachmentIpfsCids: number;
  };
}

export interface LegacyDmPurgeOptions {
  readonly nowMillis: number;
  readonly cutoffMillis: number;
  readonly batchSize?: number;
  /** Only these waves (rehearsal on a few conversations first). */
  readonly waveIds?: readonly string[];
  /**
   * Waves under a legal hold or preservation request: never touched by this
   * run. Purge them later, with `waveIds`, once the hold is released.
   */
  readonly heldWaveIds?: readonly string[];
  readonly maxWaves?: number;
  readonly onMedia?: (entries: LegacyDmMediaEntry[]) => void;
  readonly log?: (line: string) => void;
}

export interface LegacyDmPurgeResult {
  readonly waves: number;
  readonly drops: number;
  readonly rows: Record<string, number>;
}

export const LEGACY_DM_PURGE_DEFAULT_BATCH = 100;
export const LEGACY_DM_PURGE_MAX_BATCH = 500;

const dmDropsSql = (column: string) =>
  `${column} in (select d.id from ${DROPS_TABLE} d where d.wave_id in (${DM_WAVES_SQL}))`;

/** Replaces every occurrence (the backend targets ES5 typings). */
function replaceEvery(text: string, find: string, replacement: string): string {
  return text.split(find).join(replacement);
}

function countOf(rows: { c?: unknown }[]): number {
  return Number(rows[0]?.c ?? 0);
}

function bind(step: LegacyDmDropStep, value: unknown): unknown[] {
  return Array.from({ length: step.bindings }, () => value);
}

/** Read-only dry run: counts of what the purge would remove. */
export async function planLegacyDmPurge(
  sql: LegacyDmSql
): Promise<LegacyDmPlan> {
  const count = async (query: string, params: unknown[] = []) =>
    countOf(await sql.query<{ c: unknown }>(query, params));
  const rows: Record<string, number> = {};
  const add = (table: string, value: number) => {
    rows[table] = (rows[table] ?? 0) + value;
  };
  for (const table of LEGACY_DM_DROP_ID_TABLES) {
    add(
      table,
      await count(
        `select count(*) as c from ${table} where ${dmDropsSql('drop_id')}`
      )
    );
  }
  const dmDropIds = `select d.id from ${DROPS_TABLE} d where d.wave_id in (${DM_WAVES_SQL})`;
  for (const step of LEGACY_DM_DROP_STEPS) {
    const where = replaceEvery(step.where, '(?)', `(${dmDropIds})`);
    add(
      step.table,
      await count(`select count(*) as c from ${step.table} where ${where}`)
    );
  }
  add(
    IDENTITY_NOTIFICATIONS_TABLE,
    await count(
      `select count(*) as c from ${IDENTITY_NOTIFICATIONS_TABLE}
       where wave_id in (${DM_WAVES_SQL}) or ${replaceEvery(NOTIFICATIONS_FOR_DROPS, '(?)', `(${dmDropIds})`)}`
    )
  );
  for (const step of LEGACY_DM_WAVE_STEPS) {
    const where = replaceEvery(step.where, '= ?', `in (${DM_WAVES_SQL})`);
    add(
      `${step.table} (by wave)`,
      await count(`select count(*) as c from ${step.table} where ${where}`)
    );
  }
  const blockers: Record<string, number> = {};
  for (const blocker of LEGACY_DM_BLOCKERS) {
    blockers[blocker.name] = await count(blocker.sql);
  }
  return {
    dmWaves: await count(`select count(*) as c from (${DM_WAVES_SQL}) dm`),
    inconsistentWaves: await count(INCONSISTENT_DM_WAVES_SQL),
    drops: await count(
      `select count(*) as c from ${DROPS_TABLE} d
       join ${WAVES_TABLE} w on w.id = d.wave_id
       where d.wave_id in (${DM_WAVES_SQL}) and d.id <> w.description_drop_id`
    ),
    descriptionDropsToReset: await count(
      `select count(*) as c from ${WAVES_TABLE} w
       where w.id in (${DM_WAVES_SQL}) and (
         exists (select 1 from ${DROPS_PARTS_TABLE} p where p.drop_id = w.description_drop_id
           and (p.drop_part_id > 1 or coalesce(p.content, '') <> ? or p.quoted_drop_id is not null))
         or exists (select 1 from ${DROP_MEDIA_TABLE} m where m.drop_id = w.description_drop_id))`,
      [DM_DESCRIPTION_DEFAULT_CONTENT]
    ),
    documentationImports: await count(DOCUMENTATION_IMPORTS_SQL),
    wavesWithOpenReports: await count(WAVES_WITH_OPEN_REPORTS_SQL),
    blockers,
    rows,
    media: {
      dropMediaUrls: await count(
        `select count(distinct url) as c from ${DROP_MEDIA_TABLE} where ${dmDropsSql('drop_id')}`
      ),
      uploadObjects: await count(
        `select count(*) as c from ${DROP_MEDIA_UPLOADS_TABLE}
         where ${dmDropsSql('drop_id')} or wave_id in (${DM_WAVES_SQL})`
      ),
      attachments: await count(
        `select count(distinct attachment_id) as c from ${DROP_ATTACHMENTS_TABLE} where ${dmDropsSql('drop_id')}`
      ),
      attachmentIpfsCids: await count(
        `select count(distinct a.ipfs_cid) as c from ${ATTACHMENTS_TABLE} a
         join ${DROP_ATTACHMENTS_TABLE} da on da.attachment_id = a.id
         where a.ipfs_cid is not null and ${dmDropsSql('da.drop_id')}`
      )
    }
  };
}

function assertNoBlockers(blockers: Record<string, number>): void {
  const blocking = Object.entries(blockers).filter(([, n]) => n > 0);
  if (blocking.length) {
    throw new Error(
      `Legacy DM purge refused: ${blocking.map(([name, n]) => `${n} ${name}`).join(', ')}`
    );
  }
}

/** Deletes unencrypted DM content. Never call before the cutoff. */
export async function executeLegacyDmPurge(
  db: LegacyDmDb,
  options: LegacyDmPurgeOptions
): Promise<LegacyDmPurgeResult> {
  if (options.nowMillis < options.cutoffMillis) {
    throw new Error(
      `Legacy DM purge refused: the cutoff ${new Date(options.cutoffMillis).toISOString()} has not passed`
    );
  }
  const batchSize = options.batchSize ?? LEGACY_DM_PURGE_DEFAULT_BATCH;
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > LEGACY_DM_PURGE_MAX_BATCH
  ) {
    throw new Error(`Batch size must be 1-${LEGACY_DM_PURGE_MAX_BATCH}`);
  }
  const log = options.log ?? (() => undefined);
  const blockers: Record<string, number> = {};
  for (const blocker of LEGACY_DM_BLOCKERS) {
    blockers[blocker.name] = countOf(
      await db.query<{ c: unknown }>(blocker.sql)
    );
  }
  assertNoBlockers(blockers);

  const rows: Record<string, number> = {};
  const add = (table: string, affected: number) => {
    if (affected) rows[table] = (rows[table] ?? 0) + affected;
  };
  let waves = 0;
  let drops = 0;
  let after = 0;
  const limitReached = () =>
    options.maxWaves !== undefined && waves >= options.maxWaves;
  while (!limitReached()) {
    const page = await loadDmWavePage(
      db,
      after,
      options.waveIds,
      options.heldWaveIds
    );
    for (const wave of page) {
      if (limitReached()) break;
      after = wave.serialNo;
      let waveDrops = 0;
      while (true) {
        const deleted = await db.inTransaction((tx) =>
          purgeDropBatch(tx, wave, batchSize, add, options.onMedia)
        );
        waveDrops += deleted;
        if (deleted < batchSize) break;
      }
      await db.inTransaction((tx) =>
        purgeWaveLevel(tx, wave, add, options.onMedia)
      );
      waves += 1;
      drops += waveDrops;
      log(`wave ${wave.id}: ${waveDrops} drops deleted (${waves} waves done)`);
    }
    if (page.length < WAVE_PAGE) break;
  }
  log(`done: ${waves} waves, ${drops} drops`);
  return { waves, drops, rows };
}

interface DmWave {
  readonly id: string;
  readonly serialNo: number;
  readonly descriptionDropId: string;
}

const WAVE_PAGE = 100;

async function loadDmWavePage(
  db: LegacyDmSql,
  after: number,
  waveIds: readonly string[] | undefined,
  heldWaveIds: readonly string[] | undefined
): Promise<DmWave[]> {
  const only = waveIds?.length ? waveIds : null;
  const held = heldWaveIds?.length ? heldWaveIds : null;
  const params: unknown[] = [after];
  if (only) params.push(only);
  if (held) params.push(held);
  const page = await db.query<{
    id: string;
    serial_no: unknown;
    description_drop_id: string;
  }>(
    `select w.id, w.serial_no, w.description_drop_id from ${WAVES_TABLE} w
     where w.id in (${DM_WAVES_SQL}) and w.serial_no > ?
     ${only ? 'and w.id in (?)' : ''}
     ${held ? 'and w.id not in (?)' : ''}
     order by w.serial_no asc limit ${WAVE_PAGE}`,
    params
  );
  return page.map((row) => ({
    id: row.id,
    serialNo: Number(row.serial_no),
    descriptionDropId: row.description_drop_id
  }));
}

/** Re-checks inside the transaction that the wave is still a DM wave. */
async function assertStillDm(tx: LegacyDmSql, waveId: string): Promise<void> {
  const rows = await tx.query<{ id: string }>(
    `select w.id from ${WAVES_TABLE} w where w.id = ? and w.id in (${DM_WAVES_SQL})`,
    [waveId]
  );
  if (rows.length !== 1) {
    throw new Error(`Wave ${waveId} is no longer a DM wave; stopping`);
  }
}

async function captureMedia(
  tx: LegacyDmSql,
  dropIds: readonly string[],
  onMedia: LegacyDmPurgeOptions['onMedia']
): Promise<string[]> {
  const attachments = await tx.query<{
    id: string;
    original_bucket: string | null;
    original_key: string | null;
    ipfs_cid: string | null;
  }>(
    `select distinct a.id, a.original_bucket, a.original_key, a.ipfs_cid
     from ${ATTACHMENTS_TABLE} a join ${DROP_ATTACHMENTS_TABLE} da on da.attachment_id = a.id
     where da.drop_id in (?)`,
    [dropIds]
  );
  if (onMedia) {
    const entries: LegacyDmMediaEntry[] = [];
    const media = await tx.query<{ url: string }>(
      `select distinct url from ${DROP_MEDIA_TABLE} where drop_id in (?)`,
      [dropIds]
    );
    for (const row of media)
      entries.push({ kind: 'drop_media_url', url: row.url });
    const uploads = await tx.query<{
      public_key: string | null;
      ingest_bucket: string | null;
      ingest_key: string | null;
    }>(
      `select public_key, ingest_bucket, ingest_key from ${DROP_MEDIA_UPLOADS_TABLE} where drop_id in (?)`,
      [dropIds]
    );
    pushUploads(entries, uploads);
    for (const a of attachments) {
      if (a.original_key) {
        entries.push({
          kind: 'attachment_object',
          attachmentId: a.id,
          bucket: a.original_bucket,
          key: a.original_key
        });
      }
      if (a.ipfs_cid) {
        entries.push({
          kind: 'attachment_ipfs',
          attachmentId: a.id,
          cid: a.ipfs_cid
        });
      }
    }
    if (entries.length) onMedia(entries);
  }
  return attachments.map((a) => a.id);
}

function pushUploads(
  entries: LegacyDmMediaEntry[],
  uploads: {
    public_key: string | null;
    ingest_bucket: string | null;
    ingest_key: string | null;
  }[]
): void {
  for (const u of uploads) {
    if (u.public_key) {
      entries.push({
        kind: 'upload_object',
        bucket: null,
        key: u.public_key,
        role: 'public'
      });
    }
    if (u.ingest_key) {
      entries.push({
        kind: 'upload_object',
        bucket: u.ingest_bucket,
        key: u.ingest_key,
        role: 'ingest'
      });
    }
  }
}

async function cancelNotifications(
  tx: LegacyDmSql,
  where: string,
  params: readonly unknown[],
  add: (table: string, affected: number) => void
): Promise<void> {
  const ids = (
    await tx.query<{ id: unknown }>(
      `select id from ${IDENTITY_NOTIFICATIONS_TABLE} where ${where} order by id`,
      params
    )
  ).map((row) => row.id);
  if (!ids.length) return;
  await tx.execute(
    `insert into ${PUSH_NOTIFICATION_CANCELLATIONS_TABLE} (notification_id, cancelled_at)
     select id, ? from ${IDENTITY_NOTIFICATIONS_TABLE} where id in (?)
     on duplicate key update cancelled_at = values(cancelled_at)`,
    [Date.now(), ids]
  );
  add(
    IDENTITY_NOTIFICATIONS_TABLE,
    await tx.execute(
      `delete from ${IDENTITY_NOTIFICATIONS_TABLE} where id in (?)`,
      [ids]
    )
  );
}

async function purgeDropBatch(
  tx: LegacyDmSql,
  wave: DmWave,
  batchSize: number,
  add: (table: string, affected: number) => void,
  onMedia: LegacyDmPurgeOptions['onMedia']
): Promise<number> {
  await assertStillDm(tx, wave.id);
  const batch = await tx.query<{ id: string; author_id: string }>(
    `select d.id, d.author_id from ${DROPS_TABLE} d
     where d.wave_id = ? and d.id <> ?
     order by d.serial_no asc limit ? for update`,
    [wave.id, wave.descriptionDropId, batchSize]
  );
  if (!batch.length) return 0;
  const ids = batch.map((d) => d.id);
  const attachmentIds = await captureMedia(tx, ids, onMedia);
  await cancelNotifications(tx, NOTIFICATIONS_FOR_DROPS, [ids, ids], add);
  for (const step of LEGACY_DM_DROP_STEPS) {
    add(
      step.table,
      await tx.execute(
        `delete from ${step.table} where ${step.where}`,
        bind(step, ids)
      )
    );
  }
  for (const table of LEGACY_DM_DROP_ID_TABLES) {
    add(
      table,
      await tx.execute(`delete from ${table} where drop_id in (?)`, [ids])
    );
  }
  if (attachmentIds.length) {
    add(
      ATTACHMENTS_TABLE,
      await tx.execute(
        `delete from ${ATTACHMENTS_TABLE} where id in (?) and not exists (
           select 1 from ${DROP_ATTACHMENTS_TABLE} da where da.attachment_id = ${ATTACHMENTS_TABLE}.id)`,
        [attachmentIds]
      )
    );
  }
  const deleted = await tx.execute(
    `delete from ${DROPS_TABLE} where id in (?) and wave_id = ?`,
    [ids, wave.id]
  );
  add(DROPS_TABLE, deleted);
  await tx.execute(
    `update ${WAVE_METRICS_TABLE} set drops_count = greatest(drops_count - ?, 0) where wave_id = ?`,
    [deleted, wave.id]
  );
  const perAuthor: Record<string, number> = {};
  for (const d of batch)
    perAuthor[d.author_id] = (perAuthor[d.author_id] ?? 0) + 1;
  for (const [authorId, n] of Object.entries(perAuthor)) {
    await tx.execute(
      `update ${WAVE_DROPPER_METRICS_TABLE} set drops_count = greatest(drops_count - ?, 0)
       where wave_id = ? and dropper_id = ?`,
      [n, wave.id, authorId]
    );
  }
  return batch.length;
}

async function purgeWaveLevel(
  tx: LegacyDmSql,
  wave: DmWave,
  add: (table: string, affected: number) => void,
  onMedia: LegacyDmPurgeOptions['onMedia']
): Promise<void> {
  await assertStillDm(tx, wave.id);
  const description = [wave.descriptionDropId];
  const attachmentIds = await captureMedia(tx, description, onMedia);
  if (onMedia) {
    const uploads = await tx.query<{
      public_key: string | null;
      ingest_bucket: string | null;
      ingest_key: string | null;
    }>(
      `select public_key, ingest_bucket, ingest_key from ${DROP_MEDIA_UPLOADS_TABLE} where wave_id = ?`,
      [wave.id]
    );
    const entries: LegacyDmMediaEntry[] = [];
    pushUploads(entries, uploads);
    if (entries.length) onMedia(entries);
  }
  await cancelNotifications(
    tx,
    NOTIFICATIONS_FOR_DROPS,
    [description, description],
    add
  );
  for (const step of LEGACY_DM_DROP_STEPS) {
    add(
      step.table,
      await tx.execute(
        `delete from ${step.table} where ${step.where}`,
        bind(step, description)
      )
    );
  }
  for (const table of LEGACY_DM_DROP_ID_TABLES) {
    if (DESCRIPTION_DROP_KEPT_TABLES.includes(table)) continue;
    add(
      table,
      await tx.execute(`delete from ${table} where drop_id in (?)`, [
        description
      ])
    );
  }
  if (attachmentIds.length) {
    add(
      ATTACHMENTS_TABLE,
      await tx.execute(
        `delete from ${ATTACHMENTS_TABLE} where id in (?) and not exists (
           select 1 from ${DROP_ATTACHMENTS_TABLE} da where da.attachment_id = ${ATTACHMENTS_TABLE}.id)`,
        [attachmentIds]
      )
    );
  }
  add(
    `${DROPS_PARTS_TABLE} (description extra parts)`,
    await tx.execute(
      `delete from ${DROPS_PARTS_TABLE} where drop_id = ? and drop_part_id > 1`,
      [wave.descriptionDropId]
    )
  );
  add(
    `${DROPS_PARTS_TABLE} (description reset)`,
    await tx.execute(
      `update ${DROPS_PARTS_TABLE} set content = ?, quoted_drop_id = null, quoted_drop_part_id = null
       where drop_id = ? and drop_part_id = 1
         and (coalesce(content, '') <> ? or quoted_drop_id is not null)`,
      [
        DM_DESCRIPTION_DEFAULT_CONTENT,
        wave.descriptionDropId,
        DM_DESCRIPTION_DEFAULT_CONTENT
      ]
    )
  );
  await tx.execute(
    `update ${DROPS_TABLE} set title = null, parts_count = 1 where id = ? and wave_id = ?`,
    [wave.descriptionDropId, wave.id]
  );
  await cancelNotifications(tx, 'wave_id = ?', [wave.id], add);
  for (const step of LEGACY_DM_WAVE_STEPS) {
    add(
      `${step.table} (by wave)`,
      await tx.execute(
        `delete from ${step.table} where ${step.where}`,
        bind(step, wave.id)
      )
    );
  }
}
