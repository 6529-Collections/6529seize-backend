import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  METRIC_ROLLUP_HOUR_TABLE,
  UNIQUES_DAILY_TABLE,
  WALLET_AUTH_SESSIONS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  countActiveProfiles,
  countSignedInIdentities,
  upsertUniquesDailyMax
} from '@/api/telemetry/telemetry-uniques.db';
import { rollUpSignedInActives } from '@/api/telemetry/telemetry-actives';

const WALLET_A1 = '0x00000000000000000000000000000000000000a1';
const WALLET_A2 = '0x00000000000000000000000000000000000000a2';
const WALLET_B = '0x00000000000000000000000000000000000000b1';
const WALLET_OLD = '0x00000000000000000000000000000000000000c1';

function session(id: string, address: string, lastUsedAt: string) {
  return {
    id,
    address,
    client_type: 'web',
    created_at: '2026-10-01 00:00:00.000',
    last_used_at: lastUsedAt,
    expires_at: '2027-01-01 00:00:00.000'
  };
}

function activeIdentity(identityId: string, hourStart: string) {
  return {
    hour_start: hourStart,
    metric: 'ACTIVE_IDENTITY',
    scope: identityId,
    key1: '',
    key2: '',
    event_count: 1,
    value_sum: 0
  };
}

describeWithSeed(
  'telemetry signed-in actives',
  [
    {
      table: WALLET_AUTH_SESSIONS_TABLE,
      rows: [
        // A1 and A2 are one consolidated identity.
        session('s1', WALLET_A1, '2026-11-06 08:00:00.000'),
        session(
          's2',
          WALLET_A2.toUpperCase().replace('0X', '0x'),
          '2026-11-06 09:00:00.000'
        ),
        session('s3', WALLET_B, '2026-11-02 12:00:00.000'),
        session('s4', WALLET_OLD, '2026-09-01 12:00:00.000')
      ]
    },
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [
        { address: WALLET_A1, consolidation_key: `${WALLET_A1}-${WALLET_A2}` },
        { address: WALLET_A2, consolidation_key: `${WALLET_A1}-${WALLET_A2}` }
      ]
    },
    {
      table: METRIC_ROLLUP_HOUR_TABLE,
      rows: [
        activeIdentity('identity-1', '2026-11-06 10:00:00'),
        activeIdentity('identity-1', '2026-11-06 11:00:00'),
        activeIdentity('identity-2', '2026-11-01 10:00:00'),
        activeIdentity('identity-3', '2026-10-20 10:00:00')
      ]
    }
  ],
  () => {
    const dayStart = new Date('2026-11-06T00:00:00Z');
    const dayEnd = new Date('2026-11-07T00:00:00Z');

    it('counts distinct signed-in identities per window', async () => {
      expect(await countSignedInIdentities(dayStart, dayEnd)).toBe(1);
      expect(
        await countSignedInIdentities(new Date('2026-10-31T00:00:00Z'), dayEnd)
      ).toBe(2);
    });

    it('counts distinct identities with write activity per window', async () => {
      expect(await countActiveProfiles(dayStart, dayEnd)).toBe(1);
      expect(
        await countActiveProfiles(new Date('2026-10-08T00:00:00Z'), dayEnd)
      ).toBe(3);
    });

    it('stores only counts for the day', async () => {
      await rollUpSignedInActives('2026-11-06');
      const rows = await sqlExecutor.execute<{
        metric: string;
        count: number | string;
      }>(
        `SELECT metric, count FROM ${UNIQUES_DAILY_TABLE}
         WHERE day = '2026-11-06' ORDER BY metric`
      );
      expect(
        Object.fromEntries(rows.map((row) => [row.metric, Number(row.count)]))
      ).toEqual({
        active_profiles_dau: 1,
        active_profiles_mau: 3,
        active_profiles_wau: 2,
        signed_in_dau: 1,
        signed_in_mau: 2,
        signed_in_wau: 2
      });
    });

    it('never lowers a stored anonymous count', async () => {
      await upsertUniquesDailyMax('2026-11-06', 'anonymous_visitors', 10);
      await upsertUniquesDailyMax('2026-11-06', 'anonymous_visitors', 4);
      const rows = await sqlExecutor.execute<{ count: number | string }>(
        `SELECT count FROM ${UNIQUES_DAILY_TABLE}
         WHERE day = '2026-11-06' AND metric = 'anonymous_visitors'`
      );
      expect(Number(rows[0].count)).toBe(10);
    });
  }
);
