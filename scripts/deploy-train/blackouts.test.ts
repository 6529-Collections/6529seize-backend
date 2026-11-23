import { readFileSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';

const blackouts = require('./blackouts');
const validation = require('../../src/config/deploy-config.validation.js');

const catalog = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../src/config/deploy-services.json'),
    'utf8'
  )
);

function catalogService(name: string) {
  return catalog.services.find(
    (entry: { name: string }) => entry.name === name
  );
}

const at = (iso: string) => Date.parse(iso);

describe('catalog blackout windows', () => {
  it('defers royaltiesLoop around its 02:01 UTC run, including the look-ahead', () => {
    const royalties = catalogService('royaltiesLoop');
    expect(
      blackouts.evaluateBlackout(royalties, { now: at('2026-11-24T02:01:00Z') })
        .blocked
    ).toBe(true);
    const early = blackouts.evaluateBlackout(royalties, {
      now: at('2026-11-24T01:45:00Z')
    });
    expect(early.blocked).toBe(true);
    expect(early.from).toBe('2026-11-24T01:55Z');
    expect(
      blackouts.evaluateBlackout(royalties, { now: at('2026-11-24T02:30:00Z') })
        .blocked
    ).toBe(false);
    expect(
      blackouts.evaluateBlackout(royalties, {
        now: at('2026-11-24T01:45:00Z'),
        lookaheadMinutes: 0
      }).blocked
    ).toBe(false);
  });

  it('defers releaseDigestLoop until midnight UTC', () => {
    const digest = catalogService('releaseDigestLoop');
    expect(
      blackouts.evaluateBlackout(digest, { now: at('2026-11-24T23:30:00Z') })
        .blocked
    ).toBe(true);
    expect(
      blackouts.evaluateBlackout(digest, { now: at('2026-11-25T00:00:00Z') })
        .blocked
    ).toBe(false);
  });

  it('follows Europe/Athens mint hours across daylight saving time', () => {
    const claims = catalogService('claimsBuilder');
    const blocked = (iso: string) =>
      blackouts.evaluateBlackout(claims, { now: at(iso), lookaheadMinutes: 0 })
        .blocked;
    // Monday 17:45 Athens: UTC+2 in winter, UTC+3 in summer.
    expect(blocked('2026-11-23T15:45:00Z')).toBe(true);
    expect(blocked('2026-07-06T14:45:00Z')).toBe(true);
    // The same UTC time on a Tuesday is outside the launch window.
    expect(blocked('2026-11-24T18:15:00Z')).toBe(false);
    // Tuesday 17:00 Athens closes Monday's mint.
    expect(blocked('2026-11-24T15:00:00Z')).toBe(true);
    // Sunday has no mint work.
    expect(blocked('2026-11-29T15:45:00Z')).toBe(false);
    for (const name of ['claimsMediaArweaveUploader', 's3Uploader']) {
      expect(catalogService(name).deploy_blackouts).toEqual(
        claims.deploy_blackouts
      );
    }
  });

  it('applies overnight windows to the day they start on', () => {
    const rule = {
      type: 'window',
      reason: 'late job',
      start: '23:00',
      end: '00:30',
      days: ['mon']
    };
    expect(
      blackouts.isWindowRuleActive(rule, new Date('2026-11-23T23:10:00Z'))
    ).toBe(true);
    expect(
      blackouts.isWindowRuleActive(rule, new Date('2026-11-24T00:10:00Z'))
    ).toBe(true);
    expect(
      blackouts.isWindowRuleActive(rule, new Date('2026-11-25T00:10:00Z'))
    ).toBe(false);
    expect(
      blackouts.isWindowRuleActive(rule, new Date('2026-11-24T23:10:00Z'))
    ).toBe(false);
  });

  it('matches a plain UTC window minute by minute', () => {
    const pad = (value: number) => `0${value}`.slice(-2);
    const clock = (minutes: number) =>
      minutes === 1440
        ? '24:00'
        : `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
    const property = fc.property(
      fc.integer({ min: 0, max: 1439 }),
      fc.integer({ min: 1, max: 1440 }),
      fc.integer({ min: 0, max: 7 * 24 * 60 - 1 }),
      (start, end, offset) => {
        fc.pre(start < end);
        const rule = {
          type: 'window',
          reason: 'r',
          start: clock(start),
          end: clock(end)
        };
        const instant = new Date(Date.UTC(2026, 10, 23) + offset * 60000);
        const minuteOfDay = offset % 1440;
        return (
          blackouts.isWindowRuleActive(rule, instant) ===
          (minuteOfDay >= start && minuteOfDay < end)
        );
      }
    );
    expect(() => fc.assert(property)).not.toThrow();
  });
});

describe('team windows', () => {
  const known = new Set([
    'claimsBuilder',
    'populateHistoricConsolidatedTdh',
    'api'
  ]);
  const parse = (text: string) =>
    blackouts.parseTeamWindows(
      [{ name: 'DEPLOY_TRAIN_TEAM_WINDOWS', text }],
      known
    );

  it('blocks named services, or all services with "*"', () => {
    const windows = parse(
      JSON.stringify({
        windows: [
          {
            start: '2026-11-25T14:00Z',
            end: '2026-11-25T18:00Z',
            services: ['claimsBuilder'],
            reason: 'Card 500 mint',
            owner: 'punk6529'
          }
        ]
      })
    );
    const during = { now: at('2026-11-25T15:00:00Z'), teamWindows: windows };
    expect(
      blackouts.evaluateBlackout(catalogService('claimsBuilder'), during)
        .reasons
    ).toEqual([
      'team window until 2026-11-25T18:00Z: Card 500 mint (set by punk6529, DEPLOY_TRAIN_TEAM_WINDOWS)'
    ]);
    expect(
      blackouts.evaluateBlackout(catalogService('api'), during).blocked
    ).toBe(false);
    const freeze = parse(
      '[{"start":"2026-12-20T00:00Z","end":"2027-01-03T00:00Z","services":["*"],"reason":"Holiday freeze"}]'
    );
    expect(
      blackouts.evaluateBlackout(catalogService('api'), {
        now: at('2026-12-24T12:00:00Z'),
        teamWindows: freeze
      }).blocked
    ).toBe(true);
  });

  it('holds team-freeze services during any announced window', () => {
    const windows = parse(
      '[{"start":"2026-11-25T14:00Z","end":"2026-11-25T18:00Z","services":["claimsBuilder"],"reason":"Mint"}]'
    );
    const result = blackouts.evaluateBlackout(
      catalogService('populateHistoricConsolidatedTdh'),
      { now: at('2026-11-25T15:00:00Z'), teamWindows: windows }
    );
    expect(result.blocked).toBe(true);
    expect(result.reasons[0]).toContain('team window: Mint');
    expect(
      blackouts.evaluateBlackout(
        catalogService('populateHistoricConsolidatedTdh'),
        {
          now: at('2026-11-25T19:00:00Z'),
          teamWindows: windows
        }
      ).blocked
    ).toBe(false);
  });

  it('ignores empty sources and merges the file with the variable', () => {
    const windows = blackouts.parseTeamWindows(
      [
        { name: 'file', text: '{"windows": []}' },
        { name: 'variable', text: '' },
        {
          name: 'other',
          text: '[{"start":"2026-11-25T14:00Z","end":"2026-11-25T15:00Z","services":["*"],"reason":"x"}]'
        }
      ],
      known
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].source).toBe('other');
  });

  it.each([
    ['not json', 'is not valid JSON'],
    ['{"windows": 3}', 'must be a list'],
    [
      '[{"start":"2026-11-25","end":"2026-11-26T00:00Z","services":["*"],"reason":"x"}]',
      'UTC timestamp'
    ],
    [
      '[{"start":"2026-11-25T10:00Z","end":"2026-11-25T09:00Z","services":["*"],"reason":"x"}]',
      'after start'
    ],
    [
      '[{"start":"2026-11-01T00:00Z","end":"2026-12-15T00:00Z","services":["*"],"reason":"x"}]',
      'longer than 31 days'
    ],
    [
      '[{"start":"2026-11-25T10:00Z","end":"2026-11-25T11:00Z","services":["ghostLoop"],"reason":"x"}]',
      'unknown service ghostLoop'
    ],
    [
      '[{"start":"2026-11-25T10:00Z","end":"2026-11-25T11:00Z","services":[],"reason":"x"}]',
      'must list services'
    ],
    [
      '[{"start":"2026-11-25T10:00Z","end":"2026-11-25T11:00Z","services":["*"]}]',
      'reason is required'
    ],
    [
      '[{"start":"2026-11-25T10:00Z","end":"2026-11-25T11:00Z","services":["*"],"reason":"x","scope":"all"}]',
      'unsupported field scope'
    ]
  ])('fails closed on %s', (text, message) => {
    expect(() => parse(text)).toThrow(message);
  });
});

describe('catalog validation of train fields', () => {
  const base = catalogService('royaltiesLoop');

  it('accepts the committed catalog', () => {
    expect(() => validation.validateDeployConfig(catalog)).not.toThrow();
  });

  it.each([
    [{ deploy_train: { mode: 'later' } }, 'mode must be auto or manual'],
    [{ deploy_train: { mode: 'manual' } }, 'reason is required'],
    [{ deploy_train: { mode: 'auto', owner: 'x' } }, 'unsupported field owner'],
    [{ deploy_blackouts: {} }, 'must be a list'],
    [
      { deploy_blackouts: [{ type: 'daily', reason: 'x' }] },
      'type must be window or team-freeze'
    ],
    [
      { deploy_blackouts: [{ type: 'window', start: '01:00', end: '02:00' }] },
      'reason must be non-empty'
    ],
    [
      {
        deploy_blackouts: [
          { type: 'window', reason: 'x', start: '1:00', end: '02:00' }
        ]
      },
      'HH:MM'
    ],
    [
      {
        deploy_blackouts: [
          { type: 'window', reason: 'x', start: '02:00', end: '02:00' }
        ]
      },
      'must differ'
    ],
    [
      {
        deploy_blackouts: [
          {
            type: 'window',
            reason: 'x',
            start: '01:00',
            end: '02:00',
            timezone: 'Mars/Olympus'
          }
        ]
      },
      'IANA time zone'
    ],
    [
      {
        deploy_blackouts: [
          {
            type: 'window',
            reason: 'x',
            start: '01:00',
            end: '02:00',
            days: ['mon', 'mon']
          }
        ]
      },
      'days must be unique'
    ],
    [
      {
        deploy_blackouts: [{ type: 'team-freeze', reason: 'x', start: '01:00' }]
      },
      'unsupported field start'
    ]
  ])('rejects %j', (fields, message) => {
    expect(() =>
      validation.validateDeployServiceConfig({ ...base, ...fields }, new Set())
    ).toThrow(message);
  });
});

describe('temporary holds', () => {
  const known = new Set(['api', 'nftsLoop', 'claimsBuilder']);

  it('reads holds from the controls file and the variable', () => {
    const holds = blackouts.parseHolds(
      [
        {
          name: 'ops/deploy-train/controls.json',
          text: '{"windows": [], "holds": [{"services": ["api"], "reason": "frontend first", "owner": "dev"}]}',
          keys: ['windows', 'holds']
        },
        {
          name: 'DEPLOY_TRAIN_HOLDS',
          text: '[{"services": ["*"], "reason": "operator step"}]'
        }
      ],
      known
    );
    expect(holds.map((hold: { reason: string }) => hold.reason)).toEqual([
      'frontend first',
      'operator step'
    ]);
    expect(blackouts.holdFor({ name: 'api' }, holds.slice(0, 1))).toBe(
      'held: frontend first (set by dev, ops/deploy-train/controls.json)'
    );
    expect(
      blackouts.holdFor({ name: 'nftsLoop' }, holds.slice(0, 1))
    ).toBeNull();
    expect(blackouts.holdFor({ name: 'nftsLoop' }, holds)).toBe(
      'held: operator step (DEPLOY_TRAIN_HOLDS)'
    );
  });

  it('has no end time, unlike a team window', () => {
    const holds = blackouts.parseHolds(
      [
        {
          name: 'DEPLOY_TRAIN_HOLDS',
          text: '[{"services": ["api"], "reason": "r"}]'
        }
      ],
      known
    );
    expect(blackouts.holdFor({ name: 'api' }, holds)).toBe(
      'held: r (DEPLOY_TRAIN_HOLDS)'
    );
  });

  it.each([
    ['[{"services": ["api"]}]', 'reason is required'],
    ['[{"services": [], "reason": "r"}]', 'must list services'],
    [
      '[{"services": ["ghostLoop"], "reason": "r"}]',
      'unknown service ghostLoop'
    ],
    [
      '[{"services": ["api"], "reason": "r", "until": "x"}]',
      'unsupported field until'
    ],
    ['{"hold": []}', 'unsupported field hold']
  ])('fails closed on %s', (text, message) => {
    expect(() =>
      blackouts.parseHolds([{ name: 'DEPLOY_TRAIN_HOLDS', text }], known)
    ).toThrow(message);
  });

  it('merges per-person variables, each entry tagged with its variable', () => {
    const variables = {
      DEPLOY_TRAIN_HOLDS: '[{"services": ["nftsLoop"], "reason": "shared"}]',
      DEPLOY_TRAIN_HOLDS_PRXT6529:
        '[{"services": ["api"], "reason": "frontend first"}]',
      DEPLOY_TRAIN_HOLDS_GELATOGENESIS:
        '{"holds": [{"services": ["claimsBuilder"], "reason": "claims backfill"}]}',
      DEPLOY_TRAIN_TEAM_WINDOWS_PRXT6529: '[]',
      DEPLOY_TRAIN_MODE: 'prod',
      OTHER_DEPLOY_TRAIN_HOLDS: 'not ours'
    };
    const sources = blackouts.variableSources(variables, 'DEPLOY_TRAIN_HOLDS');
    expect(sources.map((source: { name: string }) => source.name)).toEqual([
      'DEPLOY_TRAIN_HOLDS',
      'DEPLOY_TRAIN_HOLDS_GELATOGENESIS',
      'DEPLOY_TRAIN_HOLDS_PRXT6529'
    ]);
    const holds = blackouts.parseHolds(sources, known);
    expect(
      holds.map((hold: { source: string; reason: string }) => [
        hold.source,
        hold.reason
      ])
    ).toEqual([
      ['DEPLOY_TRAIN_HOLDS', 'shared'],
      ['DEPLOY_TRAIN_HOLDS_GELATOGENESIS', 'claims backfill'],
      ['DEPLOY_TRAIN_HOLDS_PRXT6529', 'frontend first']
    ]);
    expect(blackouts.holdFor({ name: 'api' }, holds)).toBe(
      'held: frontend first (DEPLOY_TRAIN_HOLDS_PRXT6529)'
    );
    expect(
      blackouts.variableSources(variables, 'DEPLOY_TRAIN_TEAM_WINDOWS')
    ).toEqual([{ name: 'DEPLOY_TRAIN_TEAM_WINDOWS_PRXT6529', text: '[]' }]);
  });

  it('fails on a malformed entry and names the variable it came from', () => {
    const variables = {
      DEPLOY_TRAIN_HOLDS_GELATOGENESIS:
        '[{"services": ["api"], "reason": "ok"}]',
      DEPLOY_TRAIN_HOLDS_PRXT6529: '[{"services": ["api"]}]'
    };
    expect(() =>
      blackouts.parseHolds(
        blackouts.variableSources(variables, 'DEPLOY_TRAIN_HOLDS'),
        known
      )
    ).toThrow('DEPLOY_TRAIN_HOLDS_PRXT6529[0].reason is required');
    expect(() =>
      blackouts.parseTeamWindows(
        blackouts.variableSources(
          { DEPLOY_TRAIN_TEAM_WINDOWS_GELATOGENESIS: 'not json' },
          'DEPLOY_TRAIN_TEAM_WINDOWS'
        ),
        known
      )
    ).toThrow('DEPLOY_TRAIN_TEAM_WINDOWS_GELATOGENESIS is not valid JSON');
  });

  it('rejects a misspelt key in the controls file', () => {
    expect(() =>
      blackouts.parseTeamWindows(
        [
          {
            name: 'controls',
            text: '{"window": []}',
            keys: ['windows', 'holds']
          }
        ],
        known
      )
    ).toThrow('unsupported field window');
  });

  it('ships an empty committed controls file', () => {
    const text = readFileSync(
      path.resolve(__dirname, '../../ops/deploy-train/controls.json'),
      'utf8'
    );
    const source = { name: 'controls', text, keys: ['windows', 'holds'] };
    expect(blackouts.parseTeamWindows([source], known)).toEqual([]);
    expect(blackouts.parseHolds([source], known)).toEqual([]);
  });
});
