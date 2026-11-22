import {
  IdentityExportUsageError,
  parseExtraIds,
  parseFreezeTime,
  parseIdentityExportCommand
} from './cli-options';

const T = Date.UTC(2026, 10, 24);

describe('parseIdentityExportCommand', () => {
  it('reads the defaults', () => {
    expect(
      parseIdentityExportCommand(
        ['--out', 'x.json', '--revision', 'f'.repeat(40)],
        {}
      )
    ).toEqual({
      command: 'export',
      out: 'x.json',
      bulk: 2000,
      extraIdsFile: null,
      freezeMs: null,
      revision: 'f'.repeat(40),
      includeDelegations: true
    });
  });

  it('reads every option and the environment', () => {
    expect(
      parseIdentityExportCommand(
        [
          '--out',
          'x.json',
          '--bulk',
          '0',
          '--extra-ids',
          'waves.json',
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
          'b'.repeat(40)
        ],
        { IDENTITY_FREEZE_AT: '2026-11-24T00:00:00Z' }
      )
    ).toEqual(
      expect.objectContaining({ freezeMs: T + 1, revision: 'b'.repeat(40) })
    );
  });

  it.each([
    [[], '--out FILE is required'],
    [['--out'], '--out needs a value'],
    [['--out', 'x', '--bulk', '-1'], '--bulk must be a whole number'],
    [['--out', 'x', '--revision', 'abc'], 'revision must be a 40-hex'],
    [['--out', 'x'], 'The exporter revision is required'],
    [['--out', 'x', '--freeze-at', '24 Nov'], 'freeze time'],
    [['--out', 'x', '--what'], 'Unknown argument']
  ])('refuses %j', (args, message) => {
    expect(() => parseIdentityExportCommand(args as string[], {})).toThrow(
      message
    );
    expect(() => parseIdentityExportCommand(args as string[], {})).toThrow(
      IdentityExportUsageError
    );
  });

  it('answers help', () => {
    expect(parseIdentityExportCommand(['--help'], {})).toEqual({
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
