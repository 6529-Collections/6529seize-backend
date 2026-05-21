import { Timer } from './time';

describe('Timer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps repeated timer keys as separate report entries', () => {
    const timer = new Timer('request');

    timer.start('step');
    jest.advanceTimersByTime(10);
    timer.stop('step');

    timer.start('step');
    jest.advanceTimersByTime(20);
    timer.stop('step');

    const report = JSON.parse(timer.getReport()) as {
      times: { key: string; time: string }[];
    };

    expect(report.times).toEqual([
      { key: 'step', time: '10ms' },
      { key: 'step#2', time: '20ms' }
    ]);
  });

  it('keeps repeated ongoing timer keys visible separately', () => {
    const timer = new Timer('request');

    timer.start('step');
    timer.start('step');

    const report = JSON.parse(timer.getReport()) as {
      ongoingTimers: string[];
    };

    expect(report.ongoingTimers).toEqual(['step', 'step#2']);
  });
});
