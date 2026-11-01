/**
 * Explicit local operator for the D146 deletion of unencrypted DM content.
 * See docs/legacy-dm-deletion-runbook.md. Credentials stay in the process
 * environment; outputs are private files the operator keeps outside the
 * checkout. Nothing here runs on a schedule.
 *
 *   plan OUT.json                         read-only counts (dry run)
 *   execute MANIFEST.jsonl CONFIRM        delete rows; append media to MANIFEST
 *   media-plan MANIFEST.jsonl OUT.json    list S3 versions that would go
 *   media-execute MANIFEST.jsonl OUT.json CONFIRM
 *
 * CONFIRM is `<environment>:<database>:<cutoff ISO>:<mode>`.
 */
import 'reflect-metadata';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { DataSource, type QueryRunner } from 'typeorm';
import {
  ATTACHMENTS_TABLE,
  CLOUDFRONT_LINK,
  DROP_MEDIA_TABLE,
  DROP_MEDIA_UPLOADS_TABLE
} from '../../../src/constants';
import {
  deleteLegacyDmMedia,
  mediaTargetsFromManifest,
  type LegacyDmMediaTarget,
  type LegacyDmObjectStore
} from '../../../src/legacy-dm/legacy-dm-media';
import {
  executeLegacyDmPurge,
  planLegacyDmPurge,
  type LegacyDmDb,
  type LegacyDmMediaEntry,
  type LegacyDmSql
} from '../../../src/legacy-dm/legacy-dm-purge';
import {
  legacyDmDeletionCutoffIso,
  legacyDmDeletionCutoffMillis
} from '../../../src/legacy-dm/legacy-dm-retention';

const MODES = ['plan', 'execute', 'media-plan', 'media-execute'] as const;
type Mode = (typeof MODES)[number];

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function sqlFor(runner: QueryRunner): LegacyDmSql {
  return {
    query: async <T>(sql: string, params?: readonly unknown[]) =>
      (await runner.query(sql, params ? [...params] : [])) as T[],
    execute: async (sql: string, params?: readonly unknown[]) => {
      const result = await runner.query(sql, params ? [...params] : [], true);
      return Number(result.affected ?? 0);
    }
  };
}

function dbFor(runner: QueryRunner): LegacyDmDb {
  const sql = sqlFor(runner);
  return {
    ...sql,
    inTransaction: async (work) => {
      await runner.startTransaction();
      try {
        const result = await work(sql);
        await runner.commitTransaction();
        return result;
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      }
    }
  };
}

function s3Store(client: S3Client): LegacyDmObjectStore {
  return {
    listVersions: async (bucket, prefix) => {
      const out: { key: string; versionId: string | null; size: number }[] = [];
      let keyMarker: string | undefined;
      let versionMarker: string | undefined;
      do {
        const page = await client.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: prefix,
            KeyMarker: keyMarker,
            VersionIdMarker: versionMarker
          })
        );
        for (const v of page.Versions ?? []) {
          if (v.Key)
            out.push({
              key: v.Key,
              versionId: v.VersionId ?? null,
              size: Number(v.Size ?? 0)
            });
        }
        for (const m of page.DeleteMarkers ?? []) {
          if (m.Key)
            out.push({ key: m.Key, versionId: m.VersionId ?? null, size: 0 });
        }
        keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
      } while (keyMarker);
      return out;
    },
    deleteVersions: async (bucket, versions) => {
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Quiet: true,
            Objects: versions.map((v) => ({
              Key: v.key,
              ...(v.versionId && v.versionId !== 'null'
                ? { VersionId: v.versionId }
                : {})
            }))
          }
        })
      );
      if (result.Errors?.length) {
        throw new Error(
          `S3 refused ${result.Errors.length} deletions in ${bucket}`
        );
      }
      return versions.length;
    }
  };
}

function readManifest(path: string): LegacyDmMediaEntry[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LegacyDmMediaEntry);
}

async function stillReferenced(
  sql: LegacyDmSql,
  target: LegacyDmMediaTarget
): Promise<boolean> {
  const like = target.scope === 'prefix' ? `${target.key}%` : target.key;
  const rows = await sql.query(
    `select 1 from ${DROP_MEDIA_TABLE} where url like ? limit 1`,
    [`${CLOUDFRONT_LINK}/${like}`]
  );
  if (rows.length) return true;
  const uploads = await sql.query(
    `select 1 from ${DROP_MEDIA_UPLOADS_TABLE} where public_key like ? or ingest_key like ? limit 1`,
    [like, like]
  );
  if (uploads.length) return true;
  const attachments = await sql.query(
    `select 1 from ${ATTACHMENTS_TABLE} where original_key like ? limit 1`,
    [like]
  );
  return attachments.length > 0;
}

async function main() {
  const [modeArg, firstPath, secondArg, thirdArg, ...extra] =
    process.argv.slice(2);
  const mode = modeArg as Mode;
  const environment = requireEnv('LEGACY_DM_ENVIRONMENT');
  if (
    !MODES.includes(mode) ||
    !firstPath ||
    extra.length ||
    (environment !== 'staging' && environment !== 'prod')
  ) {
    throw new Error(
      'Set LEGACY_DM_ENVIRONMENT=staging|prod and run plan OUT | execute MANIFEST CONFIRM | media-plan MANIFEST OUT | media-execute MANIFEST OUT CONFIRM'
    );
  }
  const database = requireEnv('LEGACY_DM_DB_DATABASE');
  const cutoffIso = legacyDmDeletionCutoffIso();
  const confirmation =
    mode === 'execute' ? secondArg : mode === 'media-execute' ? thirdArg : null;
  if (
    (mode === 'execute' || mode === 'media-execute') &&
    confirmation !== `${environment}:${database}:${cutoffIso}:${mode}`
  ) {
    throw new Error(
      `Confirmation must be ${environment}:${database}:${cutoffIso}:${mode}`
    );
  }
  const source = new DataSource({
    type: 'mysql',
    host: requireEnv('LEGACY_DM_DB_HOST'),
    port: Number(requireEnv('LEGACY_DM_DB_PORT')),
    username: requireEnv('LEGACY_DM_DB_USER'),
    password: requireEnv('LEGACY_DM_DB_PASSWORD'),
    database,
    entities: [],
    synchronize: false,
    migrationsRun: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4'
  });
  await source.initialize();
  const runner = source.createQueryRunner('master');
  const log = (line: string) =>
    process.stdout.write(`[legacy-dm ${environment}] ${line}
`);
  try {
    await runner.query('set session lock_wait_timeout=5');
    await runner.query('set session innodb_lock_wait_timeout=5');
    if (mode === 'plan') {
      await runner.query('set session max_execution_time=600000');
      await runner.query('set session transaction read only');
      await runner.startTransaction();
      try {
        const plan = await planLegacyDmPurge(sqlFor(runner));
        writeFileSync(
          firstPath,
          JSON.stringify(
            {
              environment,
              database,
              cutoff: cutoffIso,
              at: new Date().toISOString(),
              plan
            },
            null,
            2
          ),
          { mode: 0o600 }
        );
        log(`plan written: ${plan.dmWaves} DM waves, ${plan.drops} drops`);
      } finally {
        await runner.rollbackTransaction();
      }
      return;
    }
    if (mode === 'execute') {
      // Legal holds are checked before any deletion: the operator must state
      // them, as wave ids or the word "none" (see the runbook, section 3.3).
      const held = process.env.LEGACY_DM_HELD_WAVES?.trim();
      if (!held) {
        throw new Error(
          'Set LEGACY_DM_HELD_WAVES to the held DM wave ids (comma-separated) or "none" after checking legal holds'
        );
      }
      const heldWaveIds =
        held === 'none'
          ? []
          : held
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
      log(`legal holds: ${heldWaveIds.length} DM waves excluded`);
      const result = await executeLegacyDmPurge(dbFor(runner), {
        heldWaveIds,
        nowMillis: Date.now(),
        cutoffMillis: legacyDmDeletionCutoffMillis(),
        batchSize: process.env.LEGACY_DM_PURGE_BATCH
          ? Number(process.env.LEGACY_DM_PURGE_BATCH)
          : undefined,
        waveIds: process.env.LEGACY_DM_PURGE_WAVES?.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        maxWaves: process.env.LEGACY_DM_PURGE_MAX_WAVES
          ? Number(process.env.LEGACY_DM_PURGE_MAX_WAVES)
          : undefined,
        // Write-ahead: media keys reach the manifest before their rows go.
        onMedia: (entries) =>
          appendFileSync(
            firstPath,
            entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
            { mode: 0o600 }
          ),
        log
      });
      log(`rows: ${JSON.stringify(result.rows)}`);
      return;
    }
    const outPath = secondArg;
    if (!outPath) throw new Error('Missing OUT path');
    const { targets, ipfsCids, externalUrls } = mediaTargetsFromManifest(
      readManifest(firstPath),
      { publicBucket: requireEnv('LEGACY_DM_PUBLIC_BUCKET') }
    );
    const sql = sqlFor(runner);
    const result = await deleteLegacyDmMedia({
      targets,
      store: s3Store(
        new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' })
      ),
      isStillReferenced: (target) => stillReferenced(sql, target),
      execute: mode === 'media-execute',
      log
    });
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          environment,
          mode,
          at: new Date().toISOString(),
          result,
          ipfsCids,
          externalUrls
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
  } finally {
    await runner.release();
    await source.destroy();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}
`
  );
  process.exitCode = 1;
});
