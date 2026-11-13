import { ENS_TABLE } from '@/constants';
import { fetchEnsRefresh } from '@/db';
import { describeWithSeed } from '@/tests/_setup/seed';

const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);
const rows = [1, 2, 3].map((id) => ({
  wallet: `0x${String(id).padStart(40, '0')}`,
  display: `cached-${id}.eth`,
  created_at: id === 3 ? new Date() : stale
}));

describeWithSeed(
  'ENS refresh retry exclusions',
  { table: ENS_TABLE, rows },
  () => {
    it('returns stale wallets without requiring an exclusion list', async () => {
      expect((await fetchEnsRefresh()).map((row) => row.wallet)).toEqual(
        expect.arrayContaining([rows[0].wallet, rows[1].wallet])
      );
      expect(await fetchEnsRefresh()).toHaveLength(2);
    });
    it('excludes failed wallets while continuing to select other stale wallets', async () => {
      expect(
        (await fetchEnsRefresh([rows[0].wallet])).map((row) => row.wallet)
      ).toEqual([rows[1].wallet]);
      expect(await fetchEnsRefresh([rows[0].wallet, rows[1].wallet])).toEqual(
        []
      );
    });
  }
);
