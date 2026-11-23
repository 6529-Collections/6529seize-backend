import { sqlExecutor } from '@/sql-executor';
import { transferReconciliationDb } from '@/transactions/transfer-reconciliation.db';
import { deferGroupsThatDoNotFit } from './consolidation-key-fit';

jest.mock('@/sql-executor', () => ({
  sqlExecutor: { execute: jest.fn() }
}));
jest.mock('@/transactions/transfer-reconciliation.db', () => ({
  transferReconciliationDb: { requeue: jest.fn() }
}));

const execute = jest.mocked(sqlExecutor.execute);
const requeue = jest.mocked(transferReconciliationDb.requeue);

function wallets(count: number, offset: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `0x${(offset + i + 1).toString(16).padStart(40, '0')}`
  );
}

function group(walletList: string[]): [string, string[]] {
  return [walletList.join('-'), walletList];
}

function widths(byTable: Record<string, number>) {
  execute.mockImplementation(async (_sql, params) => [
    { width: byTable[(params as { table: string }).table] }
  ]);
}

describe('deferGroupsThatDoNotFit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes groups of up to four wallets without reading the schema', async () => {
    const groups = new Map([group(wallets(4, 0)), group(wallets(1, 10))]);

    await expect(
      deferGroupsThatDoNotFit(groups, ['table_a'], 'owners')
    ).resolves.toBe(groups);
    expect(execute).not.toHaveBeenCalled();
    expect(requeue).not.toHaveBeenCalled();
  });

  it('leaves out and requeues a group whose key is longer than the narrowest table', async () => {
    widths({ table_b: 700, table_c: 200 });
    const five = group(wallets(5, 0));
    const one = group(wallets(1, 10));

    const fitting = await deferGroupsThatDoNotFit(
      new Map([five, one]),
      ['table_b', 'table_c'],
      'balances'
    );

    expect(Array.from(fitting.keys())).toEqual([one[0]]);
    expect(five[0].length).toBe(214);
    expect(requeue).toHaveBeenCalledWith(five[1], 'balances');
  });

  it('writes every group once the columns are wide, reading each width once', async () => {
    widths({ table_d: 700 });
    const sixteen = group(wallets(16, 0));
    const groups = new Map([sixteen]);

    for (let i = 0; i < 2; i++) {
      await expect(
        deferGroupsThatDoNotFit(groups, ['table_d'], 'activity')
      ).resolves.toBe(groups);
    }
    expect(sixteen[0].length).toBe(687);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requeue).not.toHaveBeenCalled();
  });

  it('counts the deferred wallets in a metric on Lambda', async () => {
    widths({ table_f: 200 });
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'nftOwnersLoop';
    let lines: string[];
    try {
      await deferGroupsThatDoNotFit(
        new Map([group(wallets(5, 0)), group(wallets(6, 20))]),
        ['table_f'],
        'owners'
      );
    } finally {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      lines = write.mock.calls.map(([line]) => String(line));
      write.mockRestore();
    }
    const metrics = lines.filter((line) => line.includes('"_aws"'));
    expect(metrics).toHaveLength(1);
    const metric = JSON.parse(metrics[0]);
    expect(metric).toMatchObject({
      Consumer: 'owners',
      ConsolidationKeyDeferredWallets: 11,
      _aws: {
        CloudWatchMetrics: [
          {
            Namespace: '6529/Holdings',
            Metrics: [{ Name: 'ConsolidationKeyDeferredWallets' }]
          }
        ]
      }
    });
  });

  it('fails when the table has no key column', async () => {
    execute.mockResolvedValue([]);
    await expect(
      deferGroupsThatDoNotFit(
        new Map([group(wallets(5, 0))]),
        ['table_e'],
        'owners'
      )
    ).rejects.toThrow('table_e');
  });
});
