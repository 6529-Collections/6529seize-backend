import { WAVES_SETTLEMENT_SENDS_TABLE } from '@/constants';
import { describeWithSeed } from '@/tests/_setup/seed';
import { SettlementSend, wavesSettlementSendsDb } from './waves-settlement.db';

const NOW = 1_764_000_000_000;

function id(n: number): string {
  return '0x' + n.toString(16).padStart(64, '0');
}

function row(n: number, fields: Partial<SettlementSend> = {}) {
  return {
    decision_id: id(n),
    occurrence: 1,
    count_next: null,
    nonce_lane: 0,
    tx_id: '0x' + String(n).repeat(64).slice(0, 64),
    sent_at: NOW,
    status: 'submitted',
    last_error: null,
    updated_at: NOW,
    ...fields
  };
}

describeWithSeed(
  'waves_settlement_sends',
  {
    table: WAVES_SETTLEMENT_SENDS_TABLE,
    rows: [
      row(1, { status: 'final', count_next: 300 }),
      row(2, { status: 'pending', nonce_lane: 2 }),
      row(3, { status: 'pending', sent_at: NOW - 3_600_000 }),
      row(4, { status: 'refused', last_error: 'not accepted' })
    ]
  },
  () => {
    it('loads the asked decisions and the recent rows in the given statuses', async () => {
      const rows = await wavesSettlementSendsDb.load(
        [id(1), id(9)],
        ['submitting', 'pending'],
        NOW - 600_000
      );
      expect(
        rows.map((it) => it.decision_id).sort((a, b) => a.localeCompare(b))
      ).toEqual([id(1), id(2)]);
      expect(rows.find((it) => it.decision_id === id(1))).toEqual({
        decision_id: id(1),
        occurrence: 1,
        count_next: 300,
        nonce_lane: 0,
        tx_id: '0x' + '1'.repeat(64),
        sent_at: NOW,
        status: 'final',
        last_error: null
      });
      expect(rows.find((it) => it.decision_id === id(2))?.nonce_lane).toBe(2);
    });

    it('loads with no decisions asked', async () => {
      const rows = await wavesSettlementSendsDb.load([], ['refused'], 0);
      expect(rows.map((it) => it.decision_id)).toEqual([id(4)]);
    });

    it('inserts a decision once and then replaces its row', async () => {
      const first: SettlementSend = {
        decision_id: id(7),
        occurrence: 4,
        count_next: null,
        nonce_lane: 15,
        tx_id: null,
        sent_at: NOW + 1,
        status: 'error',
        last_error: 'draft: unavailable'
      };
      await wavesSettlementSendsDb.save(first);
      const second: SettlementSend = {
        ...first,
        count_next: 128,
        tx_id: '0x' + 'ab'.repeat(32),
        sent_at: NOW + 2,
        status: 'submitting',
        last_error: null
      };
      await wavesSettlementSendsDb.save(second);
      expect(await wavesSettlementSendsDb.load([id(7)], [], 0)).toEqual([
        second
      ]);
    });
  }
);
