import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startCrpRelay } from '@/rebuild/sources/crp-relay';
import { RunningSource } from '@/rebuild/sources/running-source';
import { buildRelayWorld } from '@/rebuild/world/waves/relay-world';
import { DropIndexRunReport } from '@/wave-drop-index/drop-index';
import { RelayIngestReport } from '@/wave-drop-index/drop-index.subscriber';
import { checkRelayEvent } from '@/wave-drop-index/relay-event-check';
import {
  dropIndexEnv,
  indexRelays,
  publishRelayWorld,
  REBUILD_LIVE_FROM,
  REBUILD_RELAY_NET
} from './waves-drop-index.steps';

function reportOf(
  stored: number,
  extra: Partial<RelayIngestReport> = {}
): DropIndexRunReport {
  return {
    relays: [
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
    ],
    applied: null
  };
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
      WAVES_DROP_INDEX_LIVE_FROM: REBUILD_LIVE_FROM
    });
  });

  it('runs the index until a run stores nothing new', async () => {
    const answers = [reportOf(4), reportOf(1), reportOf(0)];
    const run = jest.fn(async () => answers.shift() ?? reportOf(0));
    expect(await indexRelays('ws://127.0.0.1:9', run)).toBe(5);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenCalledWith({ env: dropIndexEnv('ws://127.0.0.1:9') });
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

  describe('with the harness relay', () => {
    let dir: string;
    let relay: RunningSource;

    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-relay-world-'));
      relay = await startCrpRelay(dir);
    });

    afterEach(async () => {
      await relay.stop();
      fs.rmSync(dir, { recursive: true, force: true });
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
