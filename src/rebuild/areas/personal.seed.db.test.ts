import 'reflect-metadata';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { rebuildPersonalTables } from '@/personal-records/personal-rebuild.step';
import type { RebuildContext } from '@/rebuild/manifest.types';
import { personalManifest } from '@/rebuild/manifests/personal.manifest';
import { seedProbeIdentities } from '@/rebuild/run/probe-fixture.steps';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { seedPersonalSettings } from './personal.seed';

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
  ['eula_consent', '*']
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
      .sort()
      .map((row) => JSON.parse(row));
  }
  return rows;
}

/** The run's files source: the seed files directory over loopback. */
async function serveFiles(dir: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent((req.url ?? '').split('/').pop() ?? '');
    const file = path.join(dir, id);
    if (!/^[A-Za-z0-9]+$/.test(id) || !fs.existsSync(file)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function contextOf(
  stepId: string,
  files: string | null,
  seedFilesDir: string | null
): RebuildContext {
  return {
    area: 'personal',
    stepId,
    sources: {
      gateway: null,
      relays: null,
      ethereum: null,
      files,
      repo: null
    },
    mark: { name: 'head', chainHeight: null, ethBlock: null },
    seedFilesDir
  } as RebuildContext;
}

describeWithSeed('the personal seed and its rebuild', [], () => {
  it('seeds the probe rows through the switch, and the rebuild brings them back', async () => {
    const env = { ...process.env, ...personalManifest.flags };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-seed-'));
    const server = await serveFiles(dir);
    try {
      await seedProbeIdentities();
      await seedPersonalSettings(contextOf('personal.seed', null, dir), env);
      const seeded = await snapshot();
      const seededHeads = await heads();
      const state = await sqlExecutor.execute(
        `select id, frozen, import_anchor, import_at from personal_records_state`
      );
      expect(seeded.identity_subscriptions.length).toBeGreaterThan(0);
      expect(seeded.eula_consent).toHaveLength(1);
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
        contextOf('personal.settings', `http://127.0.0.1:${port}`, null),
        env
      );
      expect(await snapshot()).toEqual(seeded);
      // As live: the live record's heads, and none from the import.
      expect(await heads()).toEqual(seededHeads);
      expect(
        await sqlExecutor.execute(
          `select id, frozen, import_anchor, import_at from personal_records_state`
        )
      ).toEqual(state);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
