import {
  identityFreezeSettingProblem,
  IdentityExportUsageError,
  parseCmsFields,
  parseExtraIds,
  parseFreezeTime,
  parseIdentityExportCommand,
  readIdentityFreezeAt
} from './cli-options';

const T = Date.UTC(2026, 10, 24);
const REV = 'f'.repeat(40);
const ENV = { IDENTITY_FREEZE_AT: '2026-11-24T00:00:00Z' };

/** An export at the freeze with every input it needs. */
const AT_FREEZE = [
  '--out',
  'x.json',
  '--revision',
  REV,
  '--freeze-at',
  String(T),
  '--expect-tdh-block',
  '24000000',
  '--extra-ids',
  'waves.json',
  '--cms-fields',
  'cms-fields.json',
  '--cms-manifest',
  'manifest.json'
];

/** AT_FREEZE without the given flags (and their values). */
function without(...flags: string[]): string[] {
  const args: string[] = [];
  for (let i = 0; i < AT_FREEZE.length; i += 2) {
    if (!flags.includes(AT_FREEZE[i])) {
      args.push(AT_FREEZE[i], AT_FREEZE[i + 1]);
    }
  }
  return args;
}

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
      cmsManifestFile: null,
      acceptOverCredit: 0,
      acceptMissingExtraIds: 0,
      acceptProfileWritesAfterFreeze: 0,
      acceptUnmatchedCms: 0,
      acceptEditsAfterFreeze: 0,
      acceptRatingsChangedAfterFreeze: 0,
      acceptDelegationsAfterFreeze: 0,
      acceptNoExtraIds: false,
      acceptBulk: null,
      notice: null,
      overwrite: false
    });
  });

  it('lets a rehearsal leave out what an export at the freeze needs', () => {
    expect(
      parseIdentityExportCommand(
        [
          '--out',
          'x.json',
          '--revision',
          REV,
          '--no-freeze',
          '--no-extra-ids',
          '--cms-fields',
          'c.json',
          '--bulk',
          '0',
          '--no-delegations'
        ],
        {}
      )
    ).toEqual(
      expect.objectContaining({
        bulk: 0,
        includeDelegations: false,
        cmsFieldsFile: 'c.json',
        cmsManifestFile: null
      })
    );
  });

  it('reads the acknowledgements and --overwrite', () => {
    expect(
      parseIdentityExportCommand(
        [
          ...AT_FREEZE,
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
          '--accept-delegations-after-freeze',
          '8',
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
        acceptDelegationsAfterFreeze: 8,
        overwrite: true
      })
    );
    expect(() =>
      parseIdentityExportCommand(
        [...AT_FREEZE, '--accept-over-credit', 'all'],
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
          '--extra-ids',
          'waves.json',
          '--expect-tdh-block',
          '24000000',
          '--cms-fields',
          'cms-fields.json',
          '--cms-manifest',
          'manifest.json'
        ],
        { ...ENV, EXPORTER_REVISION: 'A'.repeat(40) }
      )
    ).toEqual({
      command: 'export',
      out: 'x.json',
      bulk: 2000,
      extraIdsFile: 'waves.json',
      freezeMs: T,
      expectTdhBlock: 24_000_000,
      revision: 'a'.repeat(40),
      includeDelegations: true,
      cmsFieldsFile: 'cms-fields.json',
      cmsManifestFile: 'manifest.json',
      acceptOverCredit: 0,
      acceptMissingExtraIds: 0,
      acceptProfileWritesAfterFreeze: 0,
      acceptUnmatchedCms: 0,
      acceptEditsAfterFreeze: 0,
      acceptRatingsChangedAfterFreeze: 0,
      acceptDelegationsAfterFreeze: 0,
      acceptNoExtraIds: false,
      acceptBulk: null,
      notice: null,
      overwrite: false
    });
    expect(
      parseIdentityExportCommand([...AT_FREEZE, '--revision', 'b'.repeat(40)], {
        IDENTITY_FREEZE_AT: String(T)
      })
    ).toEqual(
      expect.objectContaining({ freezeMs: T, revision: 'b'.repeat(40) })
    );
  });

  it('holds the freeze to 00:00 UTC and to IDENTITY_FREEZE_AT', () => {
    const at = (freeze: string) => [
      ...without('--freeze-at'),
      '--freeze-at',
      freeze
    ];
    expect(() =>
      parseIdentityExportCommand(at('2026-11-24T00:00:01Z'), {})
    ).toThrow('The freeze time must be 00:00 UTC');
    expect(() =>
      parseIdentityExportCommand(at('2026-11-25T00:00:00Z'), ENV)
    ).toThrow(
      'the freeze 2026-11-25T00:00:00.000Z is not IDENTITY_FREEZE_AT 2026-11-24T00:00:00.000Z'
    );
    expect(parseIdentityExportCommand(at('2026-11-24T00:00:00Z'), ENV)).toEqual(
      expect.objectContaining({ freezeMs: T })
    );
    // IDENTITY_FREEZE_AT as the profile site reads it: Unix milliseconds of
    // any length are a time, so seconds name another freeze.
    expect(() =>
      parseIdentityExportCommand(at('2026-11-24T00:00:00Z'), {
        IDENTITY_FREEZE_AT: String(T / 1000)
      })
    ).toThrow('is not IDENTITY_FREEZE_AT');
    expect(() =>
      parseIdentityExportCommand(at('2026-11-24T00:00:00Z'), {
        IDENTITY_FREEZE_AT: 'Tuesday'
      })
    ).toThrow('IDENTITY_FREEZE_AT is set but is not a time ("Tuesday")');
    // Without --freeze-at, IDENTITY_FREEZE_AT gives the freeze.
    expect(parseIdentityExportCommand(without('--freeze-at'), ENV)).toEqual(
      expect.objectContaining({ freezeMs: T })
    );
  });

  it('says plainly what --no-freeze does with IDENTITY_FREEZE_AT set', () => {
    const rehearsal = [
      '--out',
      'x',
      '--revision',
      REV,
      '--no-freeze',
      '--no-extra-ids',
      '--no-cms-fields'
    ];
    expect(parseIdentityExportCommand(rehearsal, ENV)).toEqual(
      expect.objectContaining({
        freezeMs: null,
        notice:
          'IDENTITY_FREEZE_AT is set ("2026-11-24T00:00:00Z"), but --no-freeze writes a rehearsal: it is not held to that freeze and the chain\'s import never takes it'
      })
    );
    // A setting that is not a time doesn't stop a rehearsal.
    expect(
      parseIdentityExportCommand(rehearsal, { IDENTITY_FREEZE_AT: 'soon' })
    ).toEqual(expect.objectContaining({ freezeMs: null }));
    expect(() =>
      parseIdentityExportCommand([...rehearsal, '--freeze-at', String(T)], ENV)
    ).toThrow('Give --freeze-at or --no-freeze, not both');
  });

  it.each([
    [[...AT_FREEZE, '--no-delegations'], '--no-delegations is for a rehearsal'],
    [
      [...without('--cms-fields', '--cms-manifest'), '--no-cms-fields'],
      '--no-cms-fields is for a rehearsal'
    ],
    [without('--cms-manifest'), 'needs --cms-manifest FILE'],
    [
      [...without('--extra-ids'), '--no-extra-ids'],
      'acknowledge it with --accept-no-extra-ids'
    ],
    [
      [...AT_FREEZE, '--accept-no-extra-ids'],
      '--accept-no-extra-ids is only with --no-extra-ids'
    ],
    [
      [...AT_FREEZE, '--bulk', '0'],
      '--bulk 0 at the freeze is not the default 2000: acknowledge it with --accept-bulk 0'
    ],
    [
      [...AT_FREEZE, '--bulk', '0', '--accept-bulk', '500'],
      'acknowledge it with --accept-bulk 0'
    ],
    [
      [...AT_FREEZE, '--accept-bulk', '2000'],
      '--accept-bulk 2000 does not match: --bulk is the default 2000'
    ]
  ])('refuses at the freeze %j', (args, message) => {
    expect(() => parseIdentityExportCommand(args, {})).toThrow(message);
    expect(() => parseIdentityExportCommand(args, {})).toThrow(
      IdentityExportUsageError
    );
  });

  it('takes the waves list left out and another bulk only acknowledged', () => {
    expect(
      parseIdentityExportCommand(
        [
          ...without('--extra-ids'),
          '--no-extra-ids',
          '--accept-no-extra-ids',
          '--bulk',
          '0',
          '--accept-bulk',
          '0'
        ],
        {}
      )
    ).toEqual(
      expect.objectContaining({
        extraIdsFile: null,
        acceptNoExtraIds: true,
        bulk: 0,
        acceptBulk: 0
      })
    );
  });

  it('refuses an acknowledgement without --expect-tdh-block', () => {
    for (const accept of [
      ['--accept-unmatched-cms', '0'],
      ['--accept-no-extra-ids'],
      ['--accept-bulk', '0'],
      ['--accept-delegations-after-freeze', '1']
    ]) {
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
            ...accept
          ],
          {}
        )
      ).toThrow(
        `${accept[0]}: an acknowledgement is only for an export at the freeze`
      );
    }
  });

  it('needs the expected TDH block at the freeze, not in a rehearsal', () => {
    expect(() =>
      parseIdentityExportCommand(without('--expect-tdh-block'), {})
    ).toThrow('An export at the freeze needs --expect-tdh-block N');
    expect(() =>
      parseIdentityExportCommand(
        without('--expect-tdh-block', '--freeze-at'),
        ENV
      )
    ).toThrow(IdentityExportUsageError);
    expect(parseIdentityExportCommand(AT_FREEZE, {})).toEqual(
      expect.objectContaining({ expectTdhBlock: 24_000_000 })
    );
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
      'Give the freeze time (--freeze-at, or IDENTITY_FREEZE_AT) or --no-freeze'
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
    ],
    [
      ['--out', 'x', ...base, '--cms-manifest', 'm.json'],
      '--cms-manifest is the manifest of the --cms-fields file: give both'
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

describe('IDENTITY_FREEZE_AT', () => {
  it.each([
    [undefined, undefined],
    ['  ', undefined],
    ['2026-11-24T00:00:00Z', T],
    ['2026-11-24T00:00:00.000+00:00', T],
    [String(T), T],
    // The site reads any run of digits as milliseconds.
    [String(T / 1000), T / 1000],
    ['2026-11-24T01:00:00+01:00', null],
    ['2026-11-24', null],
    ['soon', null]
  ])('reads %j as the profile site does', (raw, expected) => {
    expect(readIdentityFreezeAt(raw)).toBe(expected);
  });

  it('must name the freeze for an export at the freeze', () => {
    expect(identityFreezeSettingProblem(T, '2026-11-24T00:00:00Z')).toBeNull();
    expect(identityFreezeSettingProblem(T, String(T))).toBeNull();
    expect(identityFreezeSettingProblem(T, undefined)).toContain(
      'IDENTITY_FREEZE_AT is not set: an export at the freeze (2026-11-24T00:00:00.000Z)'
    );
    expect(identityFreezeSettingProblem(T, 'later')).toBe(
      'IDENTITY_FREEZE_AT is set but is not a time ("later"): the run cannot tell which freeze it exports'
    );
    expect(identityFreezeSettingProblem(T, '2026-11-25T00:00:00Z')).toBe(
      'the freeze 2026-11-24T00:00:00.000Z is not IDENTITY_FREEZE_AT 2026-11-25T00:00:00.000Z'
    );
    expect(identityFreezeSettingProblem(T, '9'.repeat(16))).toContain(
      `is not IDENTITY_FREEZE_AT ${'9'.repeat(16)}`
    );
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
