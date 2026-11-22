import {
  IdentityExportUsageError,
  parseExtraIds,
  parseFreezeTime,
  parseIdentityExportCommand
} from './cli-options';

const T = Date.UTC(2026, 10, 24);
const REV = 'f'.repeat(40);

describe('parseIdentityExportCommand', () => {
  it('reads a rehearsal export', () => {
    expect(
      parseIdentityExportCommand(
        ['--out', 'x.json', '--revision', REV, '--no-freeze', '--no-extra-ids'],
        {}
      )
    ).toEqual({
      command: 'export',
      out: 'x.json',
      bulk: 2000,
      extraIdsFile: null,
      freezeMs: null,
      expectTdhBlock: null,
      revision: REV,
      includeDelegations: true
    });
  });

  it('reads the export at the freeze, from options and the environment', () => {
    expect(
      parseIdentityExportCommand(
        [
          '--out',
          'x.json',
          '--bulk',
          '0',
          '--extra-ids',
          'waves.json',
          '--expect-tdh-block',
          '24000000',
          '--no-delegations'
        ],
        {
          IDENTITY_FREEZE_AT: '2026-11-24T00:00:00Z',
          EXPORTER_REVISION: 'A'.repeat(40)
        }
      )
    ).toEqual({
      command: 'export',
      out: 'x.json',
      bulk: 0,
      extraIdsFile: 'waves.json',
      freezeMs: T,
      expectTdhBlock: 24_000_000,
      revision: 'a'.repeat(40),
      includeDelegations: false
    });
    expect(
      parseIdentityExportCommand(
        [
          '--out',
          'x',
          '--freeze-at',
          String(T + 1),
          '--revision',
          'b'.repeat(40),
          '--no-extra-ids'
        ],
        { IDENTITY_FREEZE_AT: '2026-11-24T00:00:00Z' }
      )
    ).toEqual(
      expect.objectContaining({ freezeMs: T + 1, revision: 'b'.repeat(40) })
    );
  });

  const base = ['--revision', REV, '--no-freeze', '--no-extra-ids'];
  it.each([
    [[...base], '--out FILE is required'],
    [['--out'], '--out needs a value'],
    [['--out', 'x', ...base, '--bulk', '-1'], '--bulk must be a whole number'],
    [
      ['--out', 'x', '--revision', 'abc', '--no-freeze', '--no-extra-ids'],
      'revision must be a 40-hex'
    ],
    [
      ['--out', 'x', '--no-freeze', '--no-extra-ids'],
      'The exporter revision is required'
    ],
    [['--out', 'x', '--revision', REV, '--no-extra-ids'], 'freeze time'],
    [
      [
        '--out',
        'x',
        '--revision',
        REV,
        '--no-extra-ids',
        '--no-freeze',
        '--freeze-at',
        String(T)
      ],
      'freeze time'
    ],
    [['--out', 'x', '--revision', REV, '--no-freeze'], 'waves list'],
    [
      [
        '--out',
        'x',
        '--revision',
        REV,
        '--no-freeze',
        '--no-extra-ids',
        '--extra-ids',
        'w.json'
      ],
      'waves list'
    ],
    [['--out', 'x', ...base, '--freeze-at', '24 Nov'], 'freeze time'],
    [
      ['--out', 'x', ...base, '--expect-tdh-block', 'soon'],
      '--expect-tdh-block must be a whole number'
    ],
    [['--out', 'x', ...base, '--what'], 'Unknown argument']
  ])('refuses %j', (args, message) => {
    expect(() => parseIdentityExportCommand(args as string[], {})).toThrow(
      message
    );
    expect(() => parseIdentityExportCommand(args as string[], {})).toThrow(
      IdentityExportUsageError
    );
  });

  it('answers help', () => {
    expect(parseIdentityExportCommand(['--out', 'x', '--help'], {})).toEqual({
      command: 'help'
    });
  });
});

describe('parseFreezeTime', () => {
  it.each([
    ['2026-11-24T00:00:00Z', T],
    ['2026-11-24T00:00:00.000+00:00', T],
    [String(T), T]
  ])('reads %s', (raw, millis) => {
    expect(parseFreezeTime(raw)).toBe(millis);
  });

  it('refuses Unix seconds', () => {
    expect(() => parseFreezeTime(String(T / 1000))).toThrow(
      IdentityExportUsageError
    );
  });
});

describe('parseExtraIds', () => {
  it.each([
    ['["A-1", "b-2", 3]', ['a-1', 'b-2']],
    ['{"profile_ids": ["a-1"]}', ['a-1']],
    ['a-1\n b-2  c-3', ['a-1', 'b-2', 'c-3']],
    ['', []]
  ])('reads %s', (text, ids) => {
    expect(parseExtraIds(text)).toEqual(ids);
  });

  it('refuses a JSON object without profile_ids', () => {
    expect(() => parseExtraIds('{"ids": []}')).toThrow(
      IdentityExportUsageError
    );
  });
});
