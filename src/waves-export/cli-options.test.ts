import {
  parseFreezeTime,
  parseStages,
  parseWaveIds,
  parseWavesExportCommand,
  WavesExportUsageError
} from './cli-options';

const REVISION = 'ab'.repeat(20);
const T_W = Date.UTC(2026, 10, 25, 0, 0, 0);

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
      allowFailedWaves: false
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
