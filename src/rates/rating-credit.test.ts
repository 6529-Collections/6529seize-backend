import { ProfileRepOverviewDb } from '@/api/profiles/profile-rep-overview.db';
import { RateMatter } from '@/entities/IRating';
import { RatingsDb } from './ratings.db';
import {
  countsTowardAllCategoryRep,
  creditTdh,
  creditTdhSql,
  withoutHelpBotCreditsSql
} from './rating-credit';

function onChain(on: boolean, run: () => Promise<void> | void) {
  return async () => {
    const original = process.env.FEATURE_IDENTITY_ON_CHAIN;
    if (on) process.env.FEATURE_IDENTITY_ON_CHAIN = 'true';
    else delete process.env.FEATURE_IDENTITY_ON_CHAIN;
    try {
      await run();
    } finally {
      if (original === undefined) delete process.env.FEATURE_IDENTITY_ON_CHAIN;
      else process.env.FEATURE_IDENTITY_ON_CHAIN = original;
    }
  };
}

function ratingsDb() {
  const executor = {
    execute: jest.fn().mockResolvedValue([]),
    oneOrNull: jest.fn().mockResolvedValue(null)
  };
  return { executor, db: new RatingsDb(() => executor as never) };
}

const CREDITS = `and not (matter = 'REP' and lower(trim(matter_category)) collate utf8mb4_bin = 'help6529 credits')`;

describe('rating credit', () => {
  it(
    'counts TDH + xTDH before switch-on and leaves no category out',
    onChain(false, () => {
      expect(creditTdh(10, 5)).toBe(15);
      expect(creditTdh(10, null)).toBe(10);
      expect(creditTdhSql('i')).toBe('i.tdh + i.xtdh');
      expect(withoutHelpBotCreditsSql('r')).toBe('');
    })
  );

  it(
    "counts the chain's TDH alone from switch-on and leaves the help bot's credits out of REP",
    onChain(true, () => {
      expect(creditTdh(10, 5)).toBe(10);
      expect(creditTdhSql('i')).toBe('i.tdh');
      expect(withoutHelpBotCreditsSql('r')).toBe(
        ` and not (r.matter = 'REP' and lower(trim(r.matter_category)) collate utf8mb4_bin = 'help6529 credits')`
      );
    })
  );

  it(
    'from switch-on, REP breakdowns, lists and totals leave the credit category out',
    onChain(true, async () => {
      const { executor, db } = ratingsDb();
      await db.getRatingStatsOnMatterGroupedByCategories({
        matter: RateMatter.REP,
        matter_target_id: 'p',
        rater_profile_id: 'q'
      });
      await db.getRatingsByRatersForMatter({
        given: false,
        profileId: 'p',
        page: 1,
        matter: RateMatter.REP,
        page_size: 10,
        order: 'desc',
        order_by: 'rating',
        category: null
      });
      await db.getRepRating(
        { rater_profile_id: null, target_profile_id: 'p', category: null },
        {}
      );
      await db.getTopAbsoluteRepCategoriesByTargetIds(
        { targetIds: ['p'], limitPerTarget: 3 },
        {}
      );
      await db.getRatingsForTargetsOnMatters({
        targetIds: ['p'],
        matter: RateMatter.REP
      });
      const statements = executor.execute.mock.calls.map(([sql]) =>
        String(sql)
          .replace(/r\.matter/g, 'matter')
          .replace(/\s+/g, ' ')
      );
      expect(statements.length).toBeGreaterThanOrEqual(6);
      for (const sql of statements) expect(sql).toContain(CREDITS);
    })
  );

  it(
    'serves the credit category when asked for by name',
    onChain(true, async () => {
      const { executor, db } = ratingsDb();
      await db.getRepRating(
        {
          rater_profile_id: null,
          target_profile_id: 'p',
          category: 'Help6529 Credits'
        },
        {}
      );
      expect(String(executor.execute.mock.calls[0][0])).not.toContain(
        'not (matter'
      );
    })
  );

  it(
    "from switch-on, an over-rate is measured against the chain's TDH alone",
    onChain(true, async () => {
      const { executor, db } = ratingsDb();
      await db.getOverRateMatters();
      const [sql] = executor.execute.mock.calls[0];
      expect(sql).toContain('coalesce(i.tdh, 0) as rater_credit');
      expect(sql).not.toContain('xtdh');
    })
  );

  it(
    "from switch-on, a profile's REP overview leaves the credit category out",
    onChain(true, async () => {
      const executor = {
        execute: jest.fn().mockResolvedValue([]),
        oneOrNull: jest.fn().mockResolvedValue(null)
      };
      const db = new ProfileRepOverviewDb(() => executor as never);
      for (const direction of ['incoming', 'outgoing'] as const) {
        await db.getRepOverviewStats({
          contextProfileId: 'p',
          direction,
          authenticatedProfileId: null
        });
        await db.getRepCategoriesPage({
          contextProfileId: 'p',
          direction,
          authenticatedProfileId: null,
          page: 1,
          page_size: 10
        } as never);
        await db.getRepContributorsPage({
          contextProfileId: 'p',
          direction,
          category: null,
          page: 1,
          page_size: 10
        } as never);
      }
      const statements = [
        ...executor.execute.mock.calls,
        ...executor.oneOrNull.mock.calls
      ].map(([sql]) =>
        String(sql)
          .replace(/r\.matter/g, 'matter')
          .replace(/\s+/g, ' ')
      );
      expect(statements.length).toBe(7);
      for (const sql of statements) expect(sql).toContain(CREDITS);
    })
  );

  it("counts the help bot's credits toward all-category REP only before switch-on", async () => {
    await onChain(false, () => {
      expect(countsTowardAllCategoryRep('REP', 'Help6529 Credits')).toBe(true);
    })();
    await onChain(true, () => {
      expect(countsTowardAllCategoryRep('REP', 'Help6529 Credits')).toBe(false);
      // Trimmed and case-blind, as the mirror, the export and the SQL.
      expect(countsTowardAllCategoryRep('REP', ' help6529 CREDITS ')).toBe(
        false
      );
      expect(countsTowardAllCategoryRep('REP', 'Help6529 Credits x')).toBe(
        true
      );
      expect(countsTowardAllCategoryRep('CIC', 'Help6529 Credits')).toBe(true);
      expect(countsTowardAllCategoryRep('REP', 'Kind')).toBe(true);
    })();
  });

  it(
    'from switch-on, the given REP of a group member leaves the credits out',
    onChain(true, async () => {
      const executor = { execute: jest.fn().mockResolvedValue([]) };
      const { UserGroupsDb } = await import('@/user-groups/user-groups.db');
      await new UserGroupsDb(() => executor as never).getGivenCicAndRep('p');
      expect(
        String(executor.execute.mock.calls[0][0]).replace(/\s+/g, ' ')
      ).toContain(CREDITS);
    })
  );
});
