import 'reflect-metadata';
import { sqlExecutor } from '../sql-executor';
import { describeWithSeed } from '../tests/_setup/seed';
import { CicDb } from './cic.db';
import { RequestContext } from '../request.context';
import { CIC_STATEMENTS_TABLE } from '@/constants';
import { CicStatementGroup } from '../entities/ICICStatement';

describeWithSeed(
  'CicDb',
  {
    table: CIC_STATEMENTS_TABLE,
    rows: [
      {
        id: 'bio-old',
        profile_id: 'target-1',
        statement_group: CicStatementGroup.GENERAL,
        statement_type: 'BIO',
        statement_comment: null,
        statement_value: 'older bio',
        crated_at: new Date('2024-01-01T00:00:00Z')
      },
      {
        id: 'bio-new',
        profile_id: 'target-1',
        statement_group: CicStatementGroup.GENERAL,
        statement_type: 'BIO',
        statement_comment: null,
        statement_value: 'latest bio',
        crated_at: new Date('2024-02-01T00:00:00Z')
      },
      {
        id: 'contact',
        profile_id: 'target-1',
        statement_group: CicStatementGroup.CONTACT,
        statement_type: 'EMAIL',
        statement_comment: null,
        statement_value: 'ignored@example.com',
        crated_at: new Date('2024-03-01T00:00:00Z')
      },
      {
        id: 'bio-target-2',
        profile_id: 'target-2',
        statement_group: CicStatementGroup.GENERAL,
        statement_type: 'BIO',
        statement_comment: null,
        statement_value: 'second bio',
        crated_at: new Date('2024-01-15T00:00:00Z')
      }
    ]
  },
  () => {
    const repo = new CicDb(() => sqlExecutor);
    const ctx: RequestContext = { timer: undefined };

    it('returns the latest general bio per profile', async () => {
      const results = await repo.getLatestBiosByProfileIds(
        ['target-2', 'missing', 'target-1'],
        ctx
      );

      expect(
        results.sort((a, b) => a.profile_id.localeCompare(b.profile_id))
      ).toEqual([
        {
          profile_id: 'target-1',
          bio: 'latest bio'
        },
        {
          profile_id: 'target-2',
          bio: 'second bio'
        }
      ]);
    });
  }
);
