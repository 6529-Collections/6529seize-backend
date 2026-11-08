import { recordNativeCompetitionRun } from './native-competition-metrics';

describe('recordNativeCompetitionRun', () => {
  afterEach(() => jest.restoreAllMocks());

  it('writes one EMF line with low-cardinality dimensions and the competition as a property', () => {
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    recordNativeCompetitionRun({
      competitionId: 'competition-1',
      operation: 'decisions',
      path: 'off_lock',
      lockedMs: 120,
      computeMs: 3_400,
      durationMs: 3_600
    });

    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0][0]);
    expect(line.endsWith('\n')).toBe(true);
    const record = JSON.parse(line);
    expect(record).toMatchObject({
      _type: '6529.native_competition_run.v1',
      Operation: 'decisions',
      Path: 'off_lock',
      competition_id: 'competition-1',
      LockedMs: 120,
      ComputeMs: 3_400,
      DurationMs: 3_600,
      Runs: 1
    });
    const [directive] = record._aws.CloudWatchMetrics;
    expect(directive.Namespace).toBe('6529/NativeCompetitions');
    expect(directive.Dimensions).toEqual([
      ['Operation', 'Path'],
      ['Operation']
    ]);
    expect(directive.Metrics.map((it: { Name: string }) => it.Name)).toEqual([
      'LockedMs',
      'ComputeMs',
      'DurationMs',
      'Runs'
    ]);
  });

  it('never throws when the line cannot be written', () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('stdout closed');
    });
    expect(() =>
      recordNativeCompetitionRun({
        competitionId: 'competition-1',
        operation: 'leaderboard',
        path: 'locked',
        lockedMs: 1,
        computeMs: 0,
        durationMs: 1
      })
    ).not.toThrow();
  });
});
