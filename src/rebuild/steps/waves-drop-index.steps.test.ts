import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startCrpRelay } from '@/rebuild/sources/crp-relay';
import { RelayRules } from '@/rebuild/sources/relay-rules';
import { RunningSource } from '@/rebuild/sources/running-source';
import { buildRelayWorld } from '@/rebuild/world/waves/relay-world';
import {
  DropIndexStore,
  RelayIngestReport
} from '@/wave-drop-index/drop-index.subscriber';
import { IngestRow } from '@/wave-drop-index/drop-index.db';
import { startCrpRelayReplay } from '@/rebuild/sources/crp-relay';
import { inProcessVerifier } from '@/rebuild/sources/relay-checks';
import { checkWavesRelayEvent } from './waves-relay-check';
import { checkRelayEvent } from '@/wave-drop-index/relay-event-check';
import {
  dropIndexConfig,
  readerAuthAnswer
} from '@/wave-drop-index/drop-index';
import { TEST_WALLET } from '@/tests/fixtures/relay-events.fixture';
import { wavesManifest } from '@/rebuild/manifests/waves.manifest';
import { RELAY_WORLD_WALLET } from '@/rebuild/world/waves/world-ids';
import {
  dropIndexEnv,
  indexRelays,
  publishRelayWorld,
  readRelaysOnce,
  REBUILD_LIVE_FROM,
  REBUILD_RELAY_NET
} from './waves-drop-index.steps';

function reportOf(
  stored: number,
  extra: Partial<RelayIngestReport> = {}
): RelayIngestReport[] {
  return [
    {
      relay: 'ws://127.0.0.1:1',
      relayId: 'r',
      received: stored,
      stored,
      held: 0,
      left: 0,
      rejected: 0,
      reasons: {},
      resyncs: 0,
      readsMembersOnly: false,
      authError: null,
      error: null,
      ...extra
    }
  ];
}

/** An in-memory store for the drop index: what it was asked to keep. */
function memoryStore() {
  const rows: IngestRow[] = [];
  const store: DropIndexStore = {
    cursors: async () => [],
    knownGrants: async () => new Map(),
    siteEvents: async () => new Map(),
    ingest: async (batch) => {
      rows.push(...batch);
      return batch.map((row, i) => ({
        ...row,
        ingest_seq: rows.length - batch.length + i + 1,
        apply_attempts: 0,
        next_try_at: null
      })) as never;
    }
  };
  return { rows, store };
}

describe('the waves drop index rebuild step', () => {
  it('builds relay events the drop index takes', () => {
    const world = buildRelayWorld();
    expect(world).toHaveLength(5);
    for (const { event, grant } of world) {
      const check = checkRelayEvent(event, grant, null);
      expect(check).toMatchObject({ ok: true });
    }
    expect(new Set(world.map((w) => w.event.id)).size).toBe(5);
  });

  it('reads the relays with the drop index on and applying off', () => {
    expect(dropIndexEnv('ws://127.0.0.1:9')).toEqual({
      FEATURE_WAVES_DROP_INDEX: 'true',
      WAVES_RELAY_URLS: 'ws://127.0.0.1:9',
      WAVES_RELAY_NET: REBUILD_RELAY_NET,
      WAVES_DROP_INDEX_BUDGET_MS: '20000',
      WAVES_DROP_INDEX_LIVE_FROM: REBUILD_LIVE_FROM,
      WAVES_DROP_INDEX_READER: expect.any(String)
    });
  });

  it("reads as the site reader the manifest declares, with the test grant's own key", () => {
    const reader = JSON.parse(
      dropIndexEnv('ws://127.0.0.1:9').WAVES_DROP_INDEX_READER
    );
    expect(reader.grant.wallet).toBe(RELAY_WORLD_WALLET);
    expect(reader.grant.wallet).toBe(TEST_WALLET);
    expect(dropIndexConfig(dropIndexEnv('ws://127.0.0.1:9'))?.reader).toEqual({
      deviceSeed: reader.device_seed,
      grant: reader.grant
    });
    expect(() =>
      readerAuthAnswer(
        dropIndexConfig(dropIndexEnv('ws://127.0.0.1:9'))!.reader!
      )
    ).not.toThrow();
    const declared = wavesManifest.relayAccess?.readers ?? [];
    expect(declared).toEqual([
      expect.objectContaining({
        wallet: RELAY_WORLD_WALLET,
        roles: ['site-reader']
      })
    ]);
  });

  it('runs the index until a run stores nothing new', async () => {
    const answers = [reportOf(4), reportOf(1), reportOf(0)];
    const run = jest.fn(async () => answers.shift() ?? reportOf(0));
    expect(await indexRelays('ws://127.0.0.1:9', run)).toBe(5);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenCalledWith(dropIndexEnv('ws://127.0.0.1:9'));
  });

  it('runs again while events are left over', async () => {
    const answers = [reportOf(0, { left: 3 }), reportOf(3), reportOf(0)];
    const run = jest.fn(async () => answers.shift() ?? reportOf(0));
    expect(await indexRelays('ws://127.0.0.1:9', run)).toBe(3);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('fails when a relay read fails', async () => {
    const run = jest.fn(async () => reportOf(0, { error: 'closed' }));
    await expect(indexRelays('ws://127.0.0.1:9', run)).rejects.toThrow(
      /failed on ws:\/\/127.0.0.1:1: closed/
    );
  });

  describe("with the world's devnet recording replayed", () => {
    let root: string;
    let relay: RunningSource;
    const RECORDING = path.join(__dirname, '..', 'world', 'waves', 'relays');

    beforeEach(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-relay-replay-'));
      relay = await startCrpRelayReplay(
        [RECORDING],
        inProcessVerifier([
          {
            area: 'waves',
            waves: ['00000000-0000-4000-8000-', '0x'],
            check: checkWavesRelayEvent
          }
        ]),
        path.join(root, 'merged'),
        RelayRules.of([wavesManifest])
      );
    });

    afterEach(async () => {
      await relay.stop();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('stores each event as first seen when the relay received it, not now', async () => {
      const recorded = new Map<string, number>(
        fs
          .readFileSync(path.join(RECORDING, 'events.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .map((item) => [
            String(item.event.id).toLowerCase(),
            Math.min(
              ...item.extra.receipts.map(
                (r: { received_at: number }) => r.received_at
              )
            )
          ])
      );
      const { rows, store } = memoryStore();
      const before = Date.now();
      const reports = await readRelaysOnce(dropIndexEnv(relay.url), {
        store,
        markSiteWritten: async () => undefined
      });
      expect(reports[0]).toMatchObject({ stored: 5, error: null });
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.received_at).toBe(recorded.get(row.event_id));
        expect(row.received_at).toBeLessThan(before);
      }
    });
  });

  describe('with the harness relay', () => {
    let dir: string;
    let relay: RunningSource;

    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-relay-world-'));
      // The relay as the run starts it: the waves area's declared access.
      relay = await startCrpRelay(dir, RelayRules.of([wavesManifest]));
    });

    afterEach(async () => {
      await relay.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("stores the run's clock as first seen when the relay sends no receipt", async () => {
      await publishRelayWorld(relay.url);
      const { rows, store } = memoryStore();
      const before = Date.now();
      await readRelaysOnce(dropIndexEnv(relay.url), {
        store,
        markSiteWritten: async () => undefined
      });
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.received_at).toBeGreaterThanOrEqual(before);
      }
    });

    it('publishes the world once; publishing again adds nothing', async () => {
      await publishRelayWorld(relay.url);
      await publishRelayWorld(relay.url);
      const lines = fs
        .readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean);
      expect(lines).toHaveLength(5);
    });
  });
});
