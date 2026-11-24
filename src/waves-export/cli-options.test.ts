import {
  parseFreezeTime,
  parseStages,
  parseWaveIds,
  parseWavesExportCommand,
  WavesExportUsageError
} from './cli-options';

const REVISION = 'ab'.repeat(20);
const T_W = Date.UTC(2026, 10, 25, 0, 0, 0);
const AFTER_FREEZE = [
  '--out',
  'O',
  '--revision',
  REVISION,
  '--freeze-at',
  '2026-11-25T00:00:00Z'
];

describe('parseWavesExportCommand', () => {
  it('reads an export at the freeze with defaults', () => {
    expect(
      parseWavesExportCommand(
        [
          '--out',
          'OUT',
          '--revision',
          REVISION,
          '--freeze-at',
          '2026-11-25T00:00:00Z'
        ],
        {}
      )
    ).toEqual({
      command: 'export',
      out: 'OUT',
      revision: REVISION,
      freezeMs: T_W,
      rehearsal: false,
      stages: [
        'waves',
        'decisions',
        'votes',
        'logs',
        'groups',
        'waverep',
        'polls',
        'drops'
      ],
      waveIds: null,
      wavesFile: null,
      pageSize: 500,
      concurrency: 4,
      bothMetric: false,
      resume: false,
      allowFailedWaves: false,
      replicaLagCheckedBy: null
    });
  });

  it('reads who checked the replica lag and how, for a run after the freeze', () => {
    expect(
      parseWavesExportCommand(
        [
          '--out',
          'OUT',
          '--revision',
          REVISION,
          '--freeze-at',
          '2026-11-25T00:00:00Z',
          '--replica-lag-checked-by',
          ' the operator ',
          '--replica-lag-check-note',
          'AuroraReplicaLagMaximum read at 00:06 UTC: 20 ms'
        ],
        {}
      )
    ).toMatchObject({
      freezeMs: T_W,
      replicaLagCheckedBy: {
        person: 'the operator',
        note: 'AuroraReplicaLagMaximum read at 00:06 UTC: 20 ms'
      }
    });
  });

  it('takes the revision and freeze time from the environment', () => {
    const command = parseWavesExportCommand(['--out', 'OUT'], {
      EXPORTER_REVISION: REVISION.toUpperCase(),
      WAVES_FREEZE_AT: String(T_W)
    });
    expect(command).toMatchObject({ revision: REVISION, freezeMs: T_W });
  });

  it('reads a rehearsal with a wave subset and options', () => {
    expect(
      parseWavesExportCommand(
        [
          '--out',
          'OUT',
          '--revision',
          REVISION,
          '--rehearsal',
          '--stages',
          'drops,waves',
          '--waves',
          'w-1,w-2',
          '--page-size',
          '200',
          '--concurrency',
          '8',
          '--both-metric',
          '--resume',
          '--allow-failed-waves'
        ],
        {}
      )
    ).toMatchObject({
      freezeMs: null,
      rehearsal: true,
      stages: ['waves', 'drops'],
      waveIds: ['w-1', 'w-2'],
      pageSize: 200,
      concurrency: 8,
      bothMetric: true,
      resume: true,
      allowFailedWaves: true
    });
  });

  it('answers help', () => {
    expect(parseWavesExportCommand(['--help'], {})).toEqual({
      command: 'help'
    });
  });

  it.each([
    [['--revision', REVISION, '--rehearsal'], '--out is required'],
    [['--out', 'O', '--rehearsal'], '--revision'],
    [['--out', 'O', '--revision', 'abc', '--rehearsal'], '--revision'],
    [['--out', 'O', '--revision', REVISION], '--freeze-at'],
    [
      [
        '--out',
        'O',
        '--revision',
        REVISION,
        '--rehearsal',
        '--freeze-at',
        '2026-11-25T00:00:00Z'
      ],
      'not both'
    ],
    [
      [
        '--out',
        'O',
        '--revision',
        REVISION,
        '--rehearsal',
        '--waves',
        'a',
        '--waves-file',
        'f'
      ],
      'not both'
    ],
    [
      ['--out', 'O', '--revision', REVISION, '--rehearsal', '--page-size', '0'],
      'positive'
    ],
    [
      ['--out', 'O', '--revision', REVISION, '--rehearsal', '--bogus'],
      'Unknown argument'
    ],
    [[...AFTER_FREEZE, '--replica-lag-checked'], 'Unknown argument'],
    [
      [...AFTER_FREEZE, '--replica-lag-checked-by', 'the operator'],
      'go together'
    ],
    [
      [...AFTER_FREEZE, '--replica-lag-check-note', 'metric read'],
      'go together'
    ],
    [
      [
        ...AFTER_FREEZE,
        '--replica-lag-checked-by',
        '  ',
        '--replica-lag-check-note',
        'metric read'
      ],
      'neither empty'
    ],
    [
      [
        ...AFTER_FREEZE,
        '--replica-lag-checked-by',
        'the operator',
        '--replica-lag-check-note',
        ' '
      ],
      'neither empty'
    ],
    [
      [
        '--out',
        'O',
        '--revision',
        REVISION,
        '--rehearsal',
        '--replica-lag-checked-by',
        'the operator',
        '--replica-lag-check-note',
        'metric read'
      ],
      'a rehearsal only reports the lag'
    ],
    [
      [
        '--out',
        'O',
        '--revision',
        REVISION,
        '--rehearsal',
        '--replica-lag-checked-by',
        'the operator'
      ],
      'a rehearsal only reports the lag'
    ],
    [['--out'], 'needs a value']
  ])('refuses %j', (args, message) => {
    expect(() => parseWavesExportCommand(args, {})).toThrow(
      WavesExportUsageError
    );
    expect(() => parseWavesExportCommand(args, {})).toThrow(message);
  });
});

describe('option values', () => {
  it.each([
    ['2026-11-25T00:00:00Z', T_W],
    ['2026-11-25T00:00:00.000+00:00', T_W],
    [String(T_W), T_W]
  ])('reads freeze time %s', (raw, expected) => {
    expect(parseFreezeTime(raw)).toBe(expected);
  });

  it.each(['2026-11-25 00:00', String(T_W / 1000), 'tomorrow'])(
    'refuses freeze time %s',
    (raw) => {
      expect(() => parseFreezeTime(raw)).toThrow(WavesExportUsageError);
    }
  );

  it('orders stages as the export runs them and refuses unknown ones', () => {
    expect(parseStages('polls, waves')).toEqual(['waves', 'polls']);
    expect(() => parseStages('light')).toThrow('Unknown stage');
    expect(() => parseStages(' , ')).toThrow('no stage');
  });

  it('reads wave ids from JSON or plain text', () => {
    expect(parseWaveIds('["a", "b", "a"]')).toEqual(['a', 'b']);
    expect(parseWaveIds('a\nb, c')).toEqual(['a', 'b', 'c']);
    expect(parseWaveIds('  ')).toEqual([]);
    expect(() => parseWaveIds('{"a": 1}')).toThrow(WavesExportUsageError);
  });
});
