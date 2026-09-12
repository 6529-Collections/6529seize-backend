import { doInDbContext } from '@/secrets';
import { main } from './cli';
import { walletTransferAnalysisService } from './wallet-transfer-analysis.service';
import { TRANSFER_RULES } from './score';

jest.mock('@/secrets', () => ({
  doInDbContext: jest.fn((fn: () => Promise<unknown>) => fn())
}));

jest.mock('./wallet-transfer-analysis.service', () => ({
  walletTransferAnalysisService: {
    status: jest.fn(),
    explain: jest.fn(),
    update: jest.fn(),
    rebuild: jest.fn(),
    report: jest.fn()
  }
}));

describe('wallet transfer analysis CLI execution', () => {
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('prints help without entering the DB context', async () => {
    await main([]);
    await main(['--help']);
    expect(doInDbContext).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('rejects invalid work before entering the DB context', async () => {
    await expect(main(['update', '--max-batches', '51'])).rejects.toThrow();
    expect(doInDbContext).not.toHaveBeenCalled();
  });

  it('uses an explicit DB context without schema synchronization or Redis', async () => {
    const result = {
      contract: '0x0000000000000000000000000000000000000001',
      rule_version: 'test',
      rules: TRANSFER_RULES,
      generated_at: 0,
      from_day: null,
      to_day_exclusive: 86_400_000,
      source_min_block: null,
      source_max_block: null,
      summary_state: null,
      source_block_range_covered: true,
      candidate_scan_limit: 10_000,
      report_query_budget_ms: 5_000,
      freshness_note:
        'Block-range coverage does not detect changed rows. Update reconciles the latest processed bucket; rebuild reconciles older corrections.',
      preselection_truncated: false,
      preselection: 'highest total transfer occasions among undeclared pairs',
      score_meaning:
        'review priority within preselection, not ownership probability',
      candidates: []
    };
    jest.mocked(walletTransferAnalysisService.report).mockResolvedValue(result);
    const beforeEnvironment = process.env.NODE_ENV;

    await main(['report', '--days', 'all', '--limit', '10']);

    expect(doInDbContext).toHaveBeenCalledWith(expect.any(Function), {
      syncEntities: false,
      skipRedis: true
    });
    expect(walletTransferAnalysisService.report).toHaveBeenCalledWith({
      command: 'report',
      days: null,
      limit: 10
    });
    expect(stdout).toHaveBeenCalledWith(`${JSON.stringify(result, null, 2)}\n`);
    expect(process.env.NODE_ENV).toBe(beforeEnvironment);
  });

  it('keeps startup diagnostics off the JSON output and restores stdout on failure', async () => {
    const failure = new Error('synthetic failure');
    jest
      .mocked(walletTransferAnalysisService.status)
      .mockImplementation(async () => {
        process.stdout.write('startup diagnostic\n');
        throw failure;
      });
    const originalWrite = process.stdout.write;

    await expect(main(['status'])).rejects.toBe(failure);

    expect(stderr).toHaveBeenCalledWith('startup diagnostic\n');
    expect(stdout).not.toHaveBeenCalled();
    expect(process.stdout.write).toBe(originalWrite);
  });
});
