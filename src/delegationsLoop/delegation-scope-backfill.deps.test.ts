import {
  MEMES_CONTRACT,
  NEVER_DATE,
  USE_CASE_CONSOLIDATION,
  USE_CASE_MINTING
} from '@/constants';
import { Not } from 'typeorm';
import type { DataSource } from 'typeorm';
import {
  applyScopeBackfillDiff,
  readDelegationRowsForBackfill
} from './delegation-scope-backfill.deps';
import type {
  DelegationRow,
  DelegationRowDiff
} from './delegation-scope-backfill';

function row(overrides: Partial<DelegationRow> = {}): DelegationRow {
  return {
    block: 10,
    from_address: '0xcold',
    to_address: '0xhot',
    collection: MEMES_CONTRACT,
    use_case: USE_CASE_MINTING,
    expiry: NEVER_DATE,
    all_tokens: true,
    token_id: 0,
    ...overrides
  };
}

function fakeDataSource() {
  const repo = {
    find: jest.fn(),
    delete: jest.fn(async () => ({ raw: [], affected: 1 })),
    update: jest.fn(async () => ({ raw: [], affected: 1, generatedMaps: [] })),
    save: jest.fn(async (rows: unknown) => rows)
  };
  const transaction = jest.fn(
    async (work: (manager: unknown) => Promise<unknown>) =>
      work({ getRepository: () => repo })
  );
  const dataSource = {
    transaction,
    getRepository: () => repo
  } as unknown as DataSource;
  return { dataSource, repo, transaction };
}

const PK = {
  from_address: '0xcold',
  to_address: '0xhot',
  collection: MEMES_CONTRACT,
  use_case: USE_CASE_MINTING
};

describe('applyScopeBackfillDiff', () => {
  it('writes deletes, updates and inserts in one transaction', async () => {
    const { dataSource, repo, transaction } = fakeDataSource();
    const diff: DelegationRowDiff = {
      inserts: [row({ block: 30, expiry: 7 })],
      deletes: [row({ block: 10 })],
      updates: [
        {
          current: row({ block: 20 }),
          expected: row({ block: 20, all_tokens: false, token_id: 61 }),
          fields: ['all_tokens']
        }
      ],
      unchanged: 4
    };

    await applyScopeBackfillDiff(diff, dataSource);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(repo.delete).toHaveBeenCalledWith({ block: 10, ...PK });
    expect(repo.update).toHaveBeenCalledWith(
      { block: 20, ...PK },
      { expiry: NEVER_DATE, all_tokens: false, token_id: 61 }
    );
    expect(repo.save).toHaveBeenCalledTimes(1);
    const [saved, options] = repo.save.mock.calls[0] as unknown as [
      DelegationRow[],
      unknown
    ];
    expect(saved).toEqual([
      expect.objectContaining(row({ block: 30, expiry: 7 }))
    ]);
    expect(options).toEqual({ chunk: 500 });
  });

  it('refuses to write a consolidation row and opens no transaction', async () => {
    const { dataSource, repo, transaction } = fakeDataSource();

    await expect(
      applyScopeBackfillDiff(
        {
          inserts: [],
          deletes: [row({ use_case: USE_CASE_CONSOLIDATION })],
          updates: [],
          unchanged: 0
        },
        dataSource
      )
    ).rejects.toThrow('consolidation (999)');

    expect(transaction).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('rejects when a write fails, so the transaction rolls back', async () => {
    const { dataSource, repo } = fakeDataSource();
    repo.save.mockRejectedValue(new Error('insert failed'));

    await expect(
      applyScopeBackfillDiff(
        { inserts: [row()], deletes: [], updates: [], unchanged: 0 },
        dataSource
      )
    ).rejects.toThrow('insert failed');
  });

  it('writes one row at a time, in block order, and stops at the first failure', async () => {
    const { dataSource, repo } = fakeDataSource();
    const writes: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const track = async (label: string, fail = false) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      writes.push(label);
      if (fail) {
        throw new Error(`${label} failed`);
      }
      return { raw: [], affected: 1, generatedMaps: [] };
    };
    repo.delete.mockImplementation(((criteria: { block: number }) =>
      track(`delete ${criteria.block}`)) as never);
    repo.update.mockImplementation(((criteria: { block: number }) =>
      track(`update ${criteria.block}`, criteria.block === 5)) as never);
    const diff: DelegationRowDiff = {
      inserts: [row({ block: 9 })],
      deletes: [row({ block: 3 }), row({ block: 1 }), row({ block: 2 })],
      updates: [7, 5, 6].map((block) => ({
        current: row({ block }),
        expected: row({ block, expiry: 1 }),
        fields: ['expiry' as const]
      })),
      unchanged: 0
    };

    await expect(applyScopeBackfillDiff(diff, dataSource)).rejects.toThrow(
      'update 5 failed'
    );

    expect(maxInFlight).toBe(1);
    expect(writes).toEqual(['delete 1', 'delete 2', 'delete 3', 'update 5']);
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('readDelegationRowsForBackfill', () => {
  it('reads every row except use case 999, normalised', async () => {
    const { dataSource, repo } = fakeDataSource();
    repo.find.mockResolvedValue([
      {
        block: 10,
        from_address: '0xcold',
        to_address: '0xhot',
        collection: MEMES_CONTRACT,
        use_case: USE_CASE_MINTING,
        expiry: '64060588800',
        all_tokens: 0,
        token_id: 61
      }
    ]);

    const rows = await readDelegationRowsForBackfill(dataSource);

    expect(repo.find).toHaveBeenCalledWith({
      where: { use_case: Not(USE_CASE_CONSOLIDATION) }
    });
    expect(rows).toEqual([row({ all_tokens: false, token_id: 61 })]);
  });
});
