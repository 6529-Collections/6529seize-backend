import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { ClaimBuild } from './waves-chain-index.claims';
import { EMPTY_INDEX_STATE, WavesChainIndexDb } from './waves-chain-index.db';
import { ChainEvent, UNKNOWN_SCAN } from './waves-chain-index.events';

const id = (n: number | string) => `0x${String(n).padStart(64, '0')}`;
const D1 = id('d1');
const D2 = id('d2');
const E1 = id('e1');
const DROP = '00000001-0000-4000-8000-000000000001';

function aBuild(
  decisionId: string,
  occurrence: number,
  height: number,
  fields: Partial<ClaimBuild> = {}
): ClaimBuild {
  return {
    network: 'net-1',
    decisionId,
    occurrence,
    height,
    entryId: E1,
    dropId: DROP,
    message: {
      drop_id: DROP,
      chain: {
        decision_id: decisionId,
        occurrence,
        entry_id: E1,
        height,
        manifest_hash: id('fe1')
      }
    },
    status: 'pending',
    reason: null,
    ...fields
  };
}

const anEvent = (height: number): ChainEvent => ({
  height,
  seq: 0,
  blockTime: 1,
  kind: 'RESULT_FINAL',
  origin: 'OPERATION',
  waveId: null,
  waveLegacyId: null,
  decisionId: D1,
  decisionLegacyId: null,
  entryId: null,
  entryLegacyId: null,
  pollId: null,
  pollLegacyId: null,
  groupId: null,
  groupLegacyId: null,
  actor: null,
  data: {}
});

describeWithSeed('WavesChainIndexDb: claim builds', [], () => {
  const db = new WavesChainIndexDb(() => sqlExecutor);

  beforeEach(async () => {
    await db.saveState({ ...EMPTY_INDEX_STATE, feedNext: 1 }, 1);
  });

  it('writes claim builds with the events, once, and sends the pending ones oldest first', async () => {
    await db.writeEvents([anEvent(20)], 21, UNKNOWN_SCAN, [
      aBuild(D2, 1, 20),
      aBuild(D1, 3, 20),
      aBuild(D1, 4, 20, {
        dropId: null,
        message: null,
        status: 'skipped',
        reason: 'entry created on the chain: no 6529.io drop'
      })
    ]);
    await db.writeEvents([], 31, UNKNOWN_SCAN, [aBuild(D1, 5, 30)]);
    const pending = await db.pendingClaimBuilds(10);
    expect(pending.map((p) => [p.decisionId, p.occurrence])).toEqual([
      [D1, 3],
      [D2, 1],
      [D1, 5]
    ]);
    expect(pending[0]).toEqual({
      network: 'net-1',
      decisionId: D1,
      occurrence: 3,
      message: aBuild(D1, 3, 20).message,
      attempts: 0
    });
    expect((await db.pendingClaimBuilds(1)).length).toBe(1);

    const key = { network: 'net-1', decisionId: D1, occurrence: 3 };
    await db.claimBuildFailed(key, 'queue down');
    await db.claimBuildSent(key, 'm-1', 1_764_000_000_000);
    // A write again (a replayed or rebuilt log) leaves the row as it is.
    await db.writeEvents([], 41, UNKNOWN_SCAN, [
      aBuild(D1, 3, 40, { entryId: id('e9') })
    ]);
    // A send marked twice counts once.
    await db.claimBuildSent(key, 'm-2', 1_764_000_000_001);
    const rows = await db.claimBuildRows();
    const sent = rows.find(
      (r) => r.decision_id === D1 && Number(r.occurrence) === 3
    )!;
    expect(sent).toMatchObject({
      status: 'sent',
      attempts: 2,
      message_id: 'm-1',
      last_error: null,
      entry_id: E1
    });
    expect(Number(sent.height)).toBe(20);
    expect(Number(sent.sent_at)).toBe(1_764_000_000_000);
    expect(rows.find((r) => Number(r.occurrence) === 4)).toMatchObject({
      status: 'skipped',
      message: null,
      drop_id: null,
      reason: 'entry created on the chain: no 6529.io drop'
    });
    expect((await db.pendingClaimBuilds(10)).map((p) => p.occurrence)).toEqual([
      1, 5
    ]);
  });

  it('keeps claim builds when the index and its log are emptied', async () => {
    await db.writeEvents([anEvent(20)], 21, UNKNOWN_SCAN, [aBuild(D1, 3, 20)]);
    await db.clearAll();
    expect(await db.claimBuildRows()).toHaveLength(1);
  });

  it('writes no claim build when the events fail to write', async () => {
    const bad = { ...anEvent(20), blockTime: Number.NaN };
    await expect(
      db.writeEvents([bad], 21, UNKNOWN_SCAN, [aBuild(D1, 3, 20)])
    ).rejects.toThrow();
    expect(await db.claimBuildRows()).toEqual([]);
  });
});
