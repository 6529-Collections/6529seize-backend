import {
  IdentityExportUsageError,
  parseCmsFields,
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
        [
          '--out',
          'x.json',
          '--revision',
          REV,
          '--no-freeze',
          '--no-extra-ids',
          '--no-cms-fields'
        ],
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
      includeDelegations: true,
      cmsFieldsFile: null,
      acceptOverCredit: 0,
      acceptMissingExtraIds: 0,
      acceptProfileWritesAfterFreeze: 0,
      acceptUnmatchedCms: 0,
      acceptEditsAfterFreeze: 0,
      acceptRatingsChangedAfterFreeze: 0,
      overwrite: false
    });
  });

  it('reads the acknowledgements and --overwrite', () => {
    const rehearsal = [
      '--revision',
      REV,
      '--freeze-at',
      String(T),
      '--expect-tdh-block',
      '24000000',
      '--no-extra-ids',
      '--no-cms-fields'
    ];
    expect(
      parseIdentityExportCommand(
        [
          '--out',
          'x.json',
          ...rehearsal,
          '--accept-over-credit',
          '4',
          '--accept-edits-after-freeze',
          '2',
          '--accept-ratings-changed-after-freeze',
          '6',
          '--accept-missing-extra-ids',
          '3',
          '--accept-profile-writes-after-freeze',
          '5',
          '--accept-unmatched-cms',
          '7',
          '--overwrite'
        ],
        {}
      )
    ).toEqual(
      expect.objectContaining({
        acceptOverCredit: 4,
        acceptEditsAfterFreeze: 2,
        acceptRatingsChangedAfterFreeze: 6,
        acceptMissingExtraIds: 3,
        acceptProfileWritesAfterFreeze: 5,
        acceptUnmatchedCms: 7,
        overwrite: true
      })
    );
    expect(() =>
      parseIdentityExportCommand(
        ['--out', 'x', ...rehearsal, '--accept-over-credit', 'all'],
        {}
      )
    ).toThrow('--accept-over-credit must be a whole number');
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
          '--no-delegations',
          '--cms-fields',
          'cms-fields.json'
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
      includeDelegations: false,
      cmsFieldsFile: 'cms-fields.json',
      acceptOverCredit: 0,
      acceptMissingExtraIds: 0,
      acceptProfileWritesAfterFreeze: 0,
      acceptUnmatchedCms: 0,
      acceptEditsAfterFreeze: 0,
      acceptRatingsChangedAfterFreeze: 0,
      overwrite: false
    });
    expect(
      parseIdentityExportCommand(
        [
          '--out',
          'x',
          '--freeze-at',
          String(T),
          '--revision',
          'b'.repeat(40),
          '--no-extra-ids',
          '--no-cms-fields',
          '--expect-tdh-block',
          '1'
        ],
        { IDENTITY_FREEZE_AT: '2026-11-24T00:00:00Z' }
      )
    ).toEqual(
      expect.objectContaining({ freezeMs: T, revision: 'b'.repeat(40) })
    );
  });

  it('holds the freeze to 00:00 UTC and to IDENTITY_FREEZE_AT', () => {
    const args = (freeze: string) => [
      '--out',
      'x',
      '--revision',
      REV,
      '--freeze-at',
      freeze,
      '--expect-tdh-block',
      '1',
      '--no-extra-ids',
      '--no-cms-fields'
    ];
    expect(() =>
      parseIdentityExportCommand(args('2026-11-24T00:00:01Z'), {})
    ).toThrow('The freeze time must be 00:00 UTC');
    expect(() =>
      parseIdentityExportCommand(args('2026-11-25T00:00:00Z'), {
        IDENTITY_FREEZE_AT: '2026-11-24T00:00:00Z'
      })
    ).toThrow('is not IDENTITY_FREEZE_AT');
    expect(
      parseIdentityExportCommand(args('2026-11-24T00:00:00Z'), {
        IDENTITY_FREEZE_AT: String(T)
      })
    ).toEqual(expect.objectContaining({ freezeMs: T }));
  });

  it('refuses an acknowledgement without --expect-tdh-block', () => {
    expect(() =>
      parseIdentityExportCommand(
        [
          '--out',
          'x',
          '--revision',
          REV,
          '--no-freeze',
          '--no-extra-ids',
          '--no-cms-fields',
          '--accept-unmatched-cms',
          '0'
        ],
        {}
      )
    ).toThrow(
      '--accept-unmatched-cms: an acknowledgement is only for an export at the freeze'
    );
  });

  it('needs the expected TDH block at the freeze, not in a rehearsal', () => {
    const atFreeze = [
      '--out',
      'x',
      '--revision',
      REV,
      '--freeze-at',
      String(T),
      '--no-extra-ids',
      '--no-cms-fields'
    ];
    expect(() => parseIdentityExportCommand(atFreeze, {})).toThrow(
      'An export at the freeze needs --expect-tdh-block N'
    );
    expect(() =>
      parseIdentityExportCommand(atFreeze, {
        IDENTITY_FREEZE_AT: '2026-11-24T00:00:00Z'
      })
    ).toThrow(IdentityExportUsageError);
    expect(
      parseIdentityExportCommand(
        [...atFreeze, '--expect-tdh-block', '24000000'],
        {}
      )
    ).toEqual(expect.objectContaining({ expectTdhBlock: 24_000_000 }));
    expect(
      parseIdentityExportCommand(
        [
          '--out',
          'x',
          '--revision',
          REV,
          '--no-freeze',
          '--no-extra-ids',
          '--no-cms-fields'
        ],
        {}
      )
    ).toEqual(expect.objectContaining({ expectTdhBlock: null }));
  });

  const base = [
    '--revision',
    REV,
    '--no-freeze',
    '--no-extra-ids',
    '--no-cms-fields'
  ];
  it.each([
    [[...base], '--out FILE is required'],
    [['--out'], '--out needs a value'],
    [['--out', 'x', ...base, '--bulk', '-1'], '--bulk must be a whole number'],
    [
      [
        '--out',
        'x',
        '--revision',
        'abc',
        '--no-freeze',
        '--no-extra-ids',
        '--no-cms-fields'
      ],
      'revision must be a 40-hex'
    ],
    [
      ['--out', 'x', '--no-freeze', '--no-extra-ids', '--no-cms-fields'],
      'The exporter revision is required'
    ],
    [
      ['--out', 'x', '--revision', REV, '--no-extra-ids', '--no-cms-fields'],
      'freeze time'
    ],
    [
      [
        '--out',
        'x',
        '--revision',
        REV,
        '--no-extra-ids',
        '--no-cms-fields',
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
        '--no-cms-fields',
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
    [['--out', 'x', ...base, '--what'], 'Unknown argument'],
    [
      [
        '--out',
        'x',
        '--revision',
        REV,
        '--no-freeze',
        '--no-extra-ids',
        '--no-cms-fields',
        '--cms-fields',
        'c.json'
      ],
      'profile site values'
    ],
    [
      ['--out', 'x', '--revision', REV, '--no-freeze', '--extra-ids', 'w.json'],
      'profile site values'
    ]
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
    [
      '["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]',
      [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002'
      ]
    ],
    [
      '{"profile_ids": ["00000000-0000-4000-8000-000000000001"]}',
      ['00000000-0000-4000-8000-000000000001']
    ],
    [
      '00000000-0000-4000-8000-000000000001\n 00000000-0000-4000-8000-000000000002  00000000-0000-4000-8000-000000000003',
      [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003'
      ]
    ],
    // Each id once.
    [
      '["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"]',
      ['00000000-0000-4000-8000-000000000001']
    ]
  ])('reads %s', (text, ids) => {
    expect(parseExtraIds(text)).toEqual(ids);
  });

  it.each([
    ['', 'is empty'],
    ['  \n ', 'is empty'],
    ['[]', 'list is empty'],
    ['{"profile_ids": []}', 'list is empty'],
    ['["a-1", 3]', 'must be a string'],
    ['[{"id": "a-1"}]', 'must be a string'],
    ['["a-1"]', 'must be profile ids (UUIDs)'],
    [
      '00000000-0000-4000-8000-000000000001 alice',
      'must be profile ids (UUIDs)'
    ],
    ['["a-1", "b-2"', 'not valid JSON'],
    ['{profile_ids: a-1}', 'not valid JSON']
  ])('refuses %j', (text, message) => {
    expect(() => parseExtraIds(text)).toThrow(message);
  });

  it('refuses a JSON object without profile_ids', () => {
    expect(() => parseExtraIds('{"ids": []}')).toThrow(
      IdentityExportUsageError
    );
  });
});

describe('parseCmsFields', () => {
  it('refuses an empty object, and two keys that are one lowercase', () => {
    expect(() => parseCmsFields('{}')).toThrow('The cms fields file is empty');
    expect(() =>
      parseCmsFields('{"A-1": {"primary": {}}, "a-1 ": {"archive": {}}}')
    ).toThrow('names a-1 twice');
  });

  it('reads profile id -> cms value, ids lowercase', () => {
    expect(
      parseCmsFields(
        '{"A-1": {"primary": {"publication": "b1", "package": "b2"}}}'
      )
    ).toEqual({ 'a-1': { primary: { publication: 'b1', package: 'b2' } } });
  });

  it.each([['not json'], ['[]'], ['{"a-1": "b1"}']])('refuses %s', (text) => {
    expect(() => parseCmsFields(text)).toThrow(IdentityExportUsageError);
  });
});
