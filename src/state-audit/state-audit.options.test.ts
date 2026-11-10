import {
  MAX_AUDIT_BLOCKS,
  parseStateAuditCommand,
  StateAuditUsageError
} from './state-audit.options';

const MEMES = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1';

describe('state audit CLI options', () => {
  it.each([
    [],
    ['--help'],
    ['help'],
    ['-h'],
    ['--contract', 'memes', '--help']
  ])('selects help for %j without parsing anything else', (...args) => {
    expect(parseStateAuditCommand(args)).toEqual({ command: 'help' });
  });

  it('parses a full request with defaults', () => {
    expect(
      parseStateAuditCommand([
        '--contract',
        'Memes',
        '--from-block',
        '100',
        '--to-block',
        '2099'
      ])
    ).toEqual({
      command: 'audit',
      request: {
        contract: 'memes',
        fromBlock: 100,
        toBlock: 2099,
        chainId: 1,
        wallets: [],
        out: null,
        format: 'json'
      }
    });
  });

  it('keeps explicit addresses, lowercases and sorts wallets', () => {
    const command = parseStateAuditCommand([
      '--contract',
      MEMES,
      '--from-block',
      '5',
      '--to-block',
      '5',
      '--chain-id',
      '1',
      '--wallets',
      `0x${'B'.repeat(40)},0x${'a'.repeat(40)},0x${'b'.repeat(40)}`,
      '--out',
      '/tmp/audit.json',
      '--format',
      'json'
    ]);
    expect(command).toEqual({
      command: 'audit',
      request: {
        contract: MEMES,
        fromBlock: 5,
        toBlock: 5,
        chainId: 1,
        wallets: [`0x${'a'.repeat(40)}`, `0x${'b'.repeat(40)}`],
        out: '/tmp/audit.json',
        format: 'json'
      }
    });
  });

  it.each([
    [['--contract', 'memes'], '--from-block requires'],
    [
      ['--contract', 'memes', '--from-block', '10', '--to-block', '9'],
      'greater than or equal'
    ],
    [
      [
        '--contract',
        'memes',
        '--from-block',
        '0',
        '--to-block',
        String(MAX_AUDIT_BLOCKS)
      ],
      `at most ${MAX_AUDIT_BLOCKS} blocks`
    ],
    [
      ['--contract', 'nextgen', '--from-block', '1', '--to-block', '1'],
      '--contract must be'
    ],
    [
      [
        '--contract',
        'memes',
        '--from-block',
        '1',
        '--to-block',
        '1',
        '--format',
        'csv'
      ],
      'only json'
    ],
    [
      [
        '--contract',
        'memes',
        '--from-block',
        '1',
        '--to-block',
        '1',
        '--wallets',
        'abc'
      ],
      'invalid address'
    ],
    [
      [
        '--contract',
        'memes',
        '--from-block',
        '1',
        '--to-block',
        '1',
        '--bogus',
        'x'
      ],
      'Unknown option'
    ],
    [
      [
        '--contract',
        'memes',
        '--contract',
        'memes',
        '--from-block',
        '1',
        '--to-block',
        '1'
      ],
      'must not be repeated'
    ]
  ])('rejects %j', (args, message) => {
    expect(() => parseStateAuditCommand(args)).toThrow(StateAuditUsageError);
    expect(() => parseStateAuditCommand(args)).toThrow(message);
  });
});
