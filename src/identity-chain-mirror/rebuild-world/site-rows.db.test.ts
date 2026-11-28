import 'reflect-metadata';
import { ADDRESS_CONSOLIDATION_KEY, IDENTITIES_TABLE } from '@/constants';
import { identitiesDb } from '@/identities/identities.db';
import { TDH_COLUMN_PLANS } from '@/rebuild/manifests/identity.manifest';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity } from '@/tests/fixtures/identity.fixture';
import { consolidationKeyOf } from '../identity-plan';
import { writeWavesPeopleTdh } from './site-rows';
import { WAVES_PEOPLE_TDH } from './world-ids';

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

/** Each person's wallets: the last two hold two. */
const WALLETS = WAVES_PEOPLE_TDH.map((_, i) =>
  i < 2 ? [wallet(0x600 + i)] : [wallet(0x610 + i), wallet(0x620 + i)]
);
const KEYS = WALLETS.map((it) => consolidationKeyOf(it));

describeWithSeed(
  "the waves world's people's TDH",
  [
    {
      table: IDENTITIES_TABLE,
      rows: WAVES_PEOPLE_TDH.map((person, i) =>
        anIdentity(
          { tdh: 0 },
          {
            consolidation_key: KEYS[i],
            profile_id: person.profileId,
            primary_address: WALLETS[i][0],
            handle: `waves_person_${i}`
          }
        )
      )
    },
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: WALLETS.flatMap((wallets, i) =>
        wallets.map((address) => ({ address, consolidation_key: KEYS[i] }))
      )
    }
  ],
  () => {
    const flag = process.env.FEATURE_IDENTITY_ON_CHAIN;
    beforeEach(() => {
      process.env.FEATURE_IDENTITY_ON_CHAIN = 'true';
    });
    afterEach(() => {
      if (flag === undefined) delete process.env.FEATURE_IDENTITY_ON_CHAIN;
      else process.env.FEATURE_IDENTITY_ON_CHAIN = flag;
    });

    it('reach identities.tdh through the scoped sync, as their credit', async () => {
      expect(await writeWavesPeopleTdh()).toBe(WAVES_PEOPLE_TDH.length);
      const rows = await sqlExecutor.execute<{
        profile_id: string;
        tdh: number | string;
      }>(
        `select profile_id, tdh from ${IDENTITIES_TABLE} where profile_id in (:ids)`,
        { ids: WAVES_PEOPLE_TDH.map((it) => it.profileId) }
      );
      const tdhOf = new Map(rows.map((it) => [it.profile_id, Number(it.tdh)]));
      for (const person of WAVES_PEOPLE_TDH) {
        expect(tdhOf.get(person.profileId)).toBe(person.tdh);
        expect(
          Number(
            await identitiesDb.getTdhAndXTdhCombinedAndFloored(person.profileId)
          )
        ).toBe(person.tdh);
      }
    });

    it("are each in one of identity's column plans on their TDH", async () => {
      await writeWavesPeopleTdh();
      const planned: string[] = [];
      for (const plan of TDH_COLUMN_PLANS) {
        expect(plan.table).toBe(IDENTITIES_TABLE);
        const rows = await sqlExecutor.execute<{ profile_id: string }>(
          `select profile_id from ${IDENTITIES_TABLE} where ${plan.where}`
        );
        planned.push(...rows.map((it) => it.profile_id));
      }
      const withTdh = await sqlExecutor.execute<{ profile_id: string }>(
        `select profile_id from ${IDENTITIES_TABLE} where tdh > 0`
      );
      const sorted = (ids: string[]) =>
        [...ids].sort((a, b) => (a < b ? -1 : Number(a > b)));
      expect(sorted(planned)).toEqual(
        sorted(withTdh.map((it) => it.profile_id))
      );
      expect(sorted(planned)).toEqual(
        sorted(WAVES_PEOPLE_TDH.map((it) => it.profileId))
      );
    });
  }
);
