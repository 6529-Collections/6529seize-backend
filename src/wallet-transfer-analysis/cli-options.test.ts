import {
  parseWalletTransferAnalysisCommand,
  WalletTransferAnalysisUsageError
} from './cli-options';

describe('wallet transfer analysis CLI options', () => {
  it.each([[], ['--help'], ['help'], ['-h'], ['update', '--help']])(
    'only selects help for %j',
    (...args) => {
      expect(parseWalletTransferAnalysisCommand(args)).toEqual({
        command: 'help'
      });
    }
  );

  it('uses small finite update defaults', () => {
    expect(parseWalletTransferAnalysisCommand(['update'])).toEqual({
      command: 'update',
      maxBatches: 5,
      maxRows: 10_000
    });
  });

  it('accepts an explicit bounded rebuild and preserves inclusive bounds', () => {
    expect(
      parseWalletTransferAnalysisCommand([
        'rebuild',
        '--from-block',
        '15000000',
        '--to-block',
        '15049999',
        '--max-rows',
        '100000'
      ])
    ).toEqual({
      command: 'rebuild',
      fromBlock: 15_000_000,
      toBlock: 15_049_999,
      maxRows: 100_000
    });
  });

  it('counts intersecting buckets rather than only range length', () => {
    expect(() =>
      parseWalletTransferAnalysisCommand([
        'rebuild',
        '--from-block',
        '999',
        '--to-block',
        '50000'
      ])
    ).toThrow('at most 50');
  });

  it.each([
    ['explain', '--from-block', '999', '--to-block', '1000'],
    ['rebuild'],
    ['rebuild', '--from-block', '20', '--to-block', '19'],
    ['update', '--max-batches', '51'],
    ['update', '--max-batches', '0'],
    ['update', '--max-rows', '100001'],
    ['update', '--max-rows', '1e3'],
    ['update', '--max-rows', '-1'],
    ['update', '--max-rows', '2.5'],
    ['update', '--max-rows', '9007199254740992'],
    ['update', '--max-rows'],
    ['update', '--max-rows', '--max-batches', '2'],
    ['update', '--max-rows', '10', '--max-rows', '20'],
    ['update', '--force'],
    ['update', '--days', '30'],
    ['status', '--max-rows', '5'],
    ['report', '--limit', '1001'],
    ['report', '--days', '7'],
    ['rebuild', '--from-block', '0', '--to-block', 'Infinity'],
    ['constructor'],
    ['__proto__'],
    ['--max-batches', '2']
  ])('rejects malformed or excessive arguments %j', (...args) => {
    expect(() => parseWalletTransferAnalysisCommand(args)).toThrow(
      WalletTransferAnalysisUsageError
    );
  });

  it('uses a bounded default report and supports lifetime output', () => {
    expect(parseWalletTransferAnalysisCommand(['report'])).toEqual({
      command: 'report',
      days: 90,
      limit: 100
    });
    expect(
      parseWalletTransferAnalysisCommand([
        'report',
        '--days',
        'all',
        '--limit',
        '1000'
      ])
    ).toEqual({ command: 'report', days: null, limit: 1_000 });
  });
});
