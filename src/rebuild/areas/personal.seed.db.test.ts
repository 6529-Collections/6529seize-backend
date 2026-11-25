import 'reflect-metadata';
import * as fs from 'node:fs';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { rebuildPersonalTables } from '@/personal-records/personal-rebuild.step';
import type { RebuildContext } from '@/rebuild/manifest.types';
import { personalManifest } from '@/rebuild/manifests/personal.manifest';
import { seedProbeIdentities } from '@/rebuild/run/probe-fixture.steps';
import { startAnvil } from '@/rebuild/sources/anvil';
import type { RunningSource } from '@/rebuild/sources/running-source';
import { byCodeUnit } from '@/signed-records/record-order';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { serveSeedFiles } from '@/tests/fixtures/seed-files-server.fixture';
import { DROPS_PARTS_TABLE, DROPS_TABLE, WAVES_TABLE } from '@/constants';
import { dropsDb } from '@/drops/drops.db';
import { DropType } from '@/entities/IDrop';
import { aWave } from '@/tests/fixtures/wave.fixture';
import {
  PERSONAL_PROBE_WAVE,
  RECORDS_WAVE_DESCRIPTION,
  seedPersonalSettings
} from './personal.seed';

/** The personal tables the probes read, and what may differ in a rebuild. */
const TABLES: readonly [string, string][] = [
  [
    'identity_subscriptions',
    'subscriber_id, target_id, target_type, target_action, wave_id, subscribed_to_all_drops'
  ],
  [
    'wave_group_notification_subscriptions',
    'identity_id, wave_id, mentioned_group'
  ],
  ['identity_mutes', 'muter_id, muted_identity_id, created_at'],
  [
    'content_moderation_profile_blocks',
    'blocker_profile_id, blocked_profile_id, created_at'
  ],
  ['drop_bookmarks', 'identity_id, drop_id, bookmarked_at'],
  ['artist_artwork_alerts', 'subscriber_id, artist_id, enabled_at'],
  ['pinned_waves', 'profile_id, wave_id, position'],
  ['profile_preferences', '*'],
  ['mention_aliases', 'id, owner_profile_id, alias'],
  ['mention_alias_members', '*'],
  // created_at and updated_at are row housekeeping (volatile in the manifest).
  [
    'push_notification_settings',
    'profile_id, device_id, identity_subscribed, identity_mentioned, identity_rep, identity_nic, drop_quoted, drop_replied, drop_voted, drop_reacted, drop_boosted, wave_created, subscription_coverage'
  ],
  ['eula_consent', '*'],
  [
    'collect_rules',
    'id, profile_id, idempotency_key, request_hash, payload_json, state, revision, created_at, updated_at'
  ],
  ['collect_rule_operations', '*']
];

/** The record heads, in one order: (family, rtype) and what they hold. */
const heads = () =>
  sqlExecutor.execute<Record<string, unknown>>(
    `select owner, family, rtype, rkey, anchor, claimed_time, event_id
     from signed_record_heads order by family, rtype, owner, rkey`
  );

async function snapshot(): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const [table, columns] of TABLES) {
    // Every row in full, sorted by every column, so order can't differ.
    const all = await sqlExecutor.execute<Record<string, unknown>>(
      `select ${columns} from ${table}`
    );
    rows[table] = all
      .map((row) => JSON.stringify(row))
      .sort(byCodeUnit)
      .map((row) => JSON.parse(row));
  }
  return rows;
}

function contextOf(
  stepId: string,
  files: string | null,
  seedFilesDir: string | null,
  ethereum: string | null = null
): RebuildContext {
  return {
    area: 'personal',
    stepId,
    sources: {
      gateway: null,
      relays: null,
      ethereum,
      files,
      repo: null
    },
    mark: { name: 'head', chainHeight: null, ethBlock: null },
    seedFilesDir
  } as RebuildContext;
}

/**
 * Each wave's drop metrics are what 6529.io's drop creation leaves, checked
 * in plain SQL against the drops (not 6529.io's own recount, which the
 * rebuild uses): the wave holds exactly `drops` drops; its row counts them
 * by type with the latest drop's own time; and each author's row counts
 * that author's drops the same way.
 */
async function expectDropMetricsOf(
  waves: readonly { readonly waveId: string; readonly drops: number }[]
) {
  for (const { waveId, drops } of waves) {
    const [row] = await sqlExecutor.execute<{
      drops_count: number;
      participatory_drops_count: number;
      latest_drop_timestamp: number;
    }>(
      `select drops_count, participatory_drops_count, latest_drop_timestamp
         from wave_metrics where wave_id = :waveId`,
      { waveId }
    );
    const [want] = await sqlExecutor.execute<{
      chat: number;
      participatory: number;
      latest: number;
    }>(
      `select sum(drop_type = 'CHAT') as chat,
              sum(drop_type = 'PARTICIPATORY') as participatory,
              max(created_at) as latest
         from drops where wave_id = :waveId`,
      { waveId }
    );
    expect(Number(want.chat) + Number(want.participatory)).toBe(drops);
    expect(row).toBeDefined();
    expect(Number(row.drops_count)).toBe(Number(want.chat));
    expect(Number(row.participatory_drops_count)).toBe(
      Number(want.participatory)
    );
    expect(Number(row.latest_drop_timestamp)).toBe(Number(want.latest));
  }
  const waveIds = waves.map((wave) => wave.waveId);
  expect(
    await sqlExecutor.execute(
      `select d.wave_id, d.author_id
         from (select wave_id, author_id,
                      sum(drop_type = 'CHAT') as chat,
                      sum(drop_type = 'PARTICIPATORY') as participatory,
                      max(created_at) as latest
                 from drops
                where wave_id in (:waveIds)
                group by wave_id, author_id) d
         left join wave_dropper_metrics m
           on m.wave_id = d.wave_id and m.dropper_id = d.author_id
        where m.wave_id is null
           or m.drops_count <> d.chat
           or m.participatory_drops_count <> d.participatory
           or m.latest_drop_timestamp <> d.latest`,
      { waveIds }
    )
  ).toEqual([]);
}

/** A row as a plain insert writes it: only the columns the table has. */
async function insertKnownColumns(
  table: string,
  row: Record<string, unknown>
): Promise<void> {
  const known = new Set(
    (
      await sqlExecutor.execute<{ name: string }>(
        `select column_name as name from information_schema.columns
          where table_schema = database() and table_name = :table`,
        { table }
      )
    ).map((column) => column.name)
  );
  const columns = Object.keys(row).filter((column) => known.has(column));
  await sqlExecutor.execute(
    `insert into ${table} (${columns.map((c) => `\`${c}\``).join(', ')})
     values (${columns.map((c) => `:${c}`).join(', ')})`,
    Object.fromEntries(
      columns.map((column) => {
        const value = row[column];
        return [
          column,
          value !== null && typeof value === 'object'
            ? JSON.stringify(value)
            : value
        ];
      })
    )
  );
}

/**
 * The records wave and its description drop as another area's seed writes
 * them before this one runs: the rows, and the drop's metrics through
 * 6529.io's own delta at the drop's time.
 */
async function writeRecordsWaveAsAnotherSeed(
  waveId: string,
  serviceProfileId: string,
  at: number
): Promise<void> {
  const { serial_no: _serial, ...wave } = aWave(
    {
      is_direct_message: false,
      created_by: serviceProfileId,
      created_at: at,
      description_drop_id: RECORDS_WAVE_DESCRIPTION
    },
    { id: waveId, name: waveId }
  );
  await insertKnownColumns(WAVES_TABLE, wave);
  await insertKnownColumns(DROPS_TABLE, {
    id: RECORDS_WAVE_DESCRIPTION,
    wave_id: waveId,
    author_id: serviceProfileId,
    created_at: at,
    parts_count: 1,
    drop_type: DropType.CHAT,
    hide_link_preview: true
  });
  await insertKnownColumns(DROPS_PARTS_TABLE, {
    drop_id: RECORDS_WAVE_DESCRIPTION,
    drop_part_id: 1,
    content: 'A wave for the rebuild check.',
    wave_id: waveId
  });
  const realNow = Date.now;
  Date.now = () => at;
  try {
    await dropsDb.applyInsertedDropMetricsDelta(
      {
        wave_id: waveId,
        author_id: serviceProfileId,
        drop_type: DropType.CHAT
      },
      {}
    );
  } finally {
    Date.now = realNow;
  }
}

describeWithSeed('the personal seed and its rebuild', [], () => {
  it('seeds the probe rows through the switch, and the rebuild brings them back', async () => {
    const env = { ...process.env, ...personalManifest.flags };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-seed-'));
    const server = await serveSeedFiles(dir);
    // Ethereum: the collect lane's released purchase was never mined, and
    // the seed uses its nonce for another transaction.
    let ethereum: RunningSource | null = null;
    try {
      ethereum = await startAnvil({
        state: null,
        logFile: path.join(dir, 'anvil.log')
      });
      await seedProbeIdentities();
      await seedPersonalSettings(
        contextOf('personal.seed', null, dir, ethereum.url),
        env
      );
      const seeded = await snapshot();
      const seededHeads = await heads();
      const state = await sqlExecutor.execute(
        `select id, frozen, import_anchor, import_at from personal_records_state`
      );
      expect(seeded.identity_subscriptions.length).toBeGreaterThan(0);
      expect(seeded.eula_consent).toHaveLength(1);
      // The seed's drops have their metrics, as drop creation writes them:
      // the probe wave's two (its description and the probe drop) and the
      // records wave's (its description, then one head per closed segment).
      const [segments] = await sqlExecutor.execute<{ n: number }>(
        `select count(*) as n from signed_record_log_segments`
      );
      expect(Number(segments.n)).toBeGreaterThan(0);
      await expectDropMetricsOf([
        { waveId: PERSONAL_PROBE_WAVE, drops: 2 },
        {
          waveId: String(env.SIGNED_RECORDS_WAVE_ID),
          drops: 1 + Number(segments.n)
        }
      ]);
      // The live follow after the import: its own head and its owner's
      // order mark. The import keeps none.
      expect(
        seededHeads.map((head) => [head.family, head.rtype, head.anchor])
      ).toEqual([
        ['ps', 'follow', 2],
        ['pv', '~owner', 2]
      ]);
      const listed = JSON.parse(
        fs.readFileSync(path.join(dir, 'files.json'), 'utf8')
      );
      expect(Object.keys(listed).length).toBeGreaterThan(0);

      for (const [table] of TABLES) {
        await sqlExecutor.execute(`delete from ${table}`);
      }
      await sqlExecutor.execute(`delete from signed_record_heads`);
      await sqlExecutor.execute(`delete from signed_record_log_segments`);
      await sqlExecutor.execute(`delete from personal_records_state`);

      const { port } = server.address() as AddressInfo;
      await rebuildPersonalTables(
        contextOf(
          'personal.settings',
          `http://127.0.0.1:${port}`,
          null,
          ethereum.url
        ),
        env
      );
      expect(await snapshot()).toEqual(seeded);
      // A settled purchase from the import, a released one from the lane.
      expect(
        seeded.collect_rule_operations.map((row) => {
          const op = row as Record<string, unknown>;
          return [
            op.operation_id,
            op.transaction_hash !== null,
            op.settlement_hash !== null
          ];
        })
      ).toEqual([
        ['rebuild-collect-op-1', true, true],
        ['rebuild-collect-op-2', true, false]
      ]);
      // As live: the live record's heads, and none from the import.
      expect(await heads()).toEqual(seededHeads);
      expect(
        await sqlExecutor.execute(
          `select id, frozen, import_anchor, import_at from personal_records_state`
        )
      ).toEqual(state);
    } finally {
      await ethereum?.stop();
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a drop another seed already wrote, with its metrics, once', async () => {
    const env = { ...process.env, ...personalManifest.flags };
    const waveId = String(env.SIGNED_RECORDS_WAVE_ID);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-seed-'));
    let ethereum: RunningSource | null = null;
    try {
      ethereum = await startAnvil({
        state: null,
        logFile: path.join(dir, 'anvil.log')
      });
      await seedProbeIdentities();
      // Another area's seed ran first: the records wave and its
      // description drop exist, with that drop's metrics.
      await writeRecordsWaveAsAnotherSeed(
        waveId,
        String(env.SIGNED_RECORDS_SERVICE_PROFILE_ID),
        1_767_225_600_000
      );
      await seedPersonalSettings(
        contextOf('personal.seed', null, dir, ethereum.url),
        env
      );
      // The description drop counts once, not again when this seed writes
      // the wave: its description, then one head per closed segment.
      const [segments] = await sqlExecutor.execute<{ n: number }>(
        `select count(*) as n from signed_record_log_segments`
      );
      expect(Number(segments.n)).toBeGreaterThan(0);
      await expectDropMetricsOf([
        { waveId: PERSONAL_PROBE_WAVE, drops: 2 },
        { waveId, drops: 1 + Number(segments.n) }
      ]);
    } finally {
      await ethereum?.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
