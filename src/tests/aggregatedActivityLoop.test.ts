const doInDbContextMock = jest.fn();
const loggerMock = { info: jest.fn(), error: jest.fn() };
const wrapLambdaHandlerMock = jest.fn((h) => h);
const updateAggregatedActivityMock = jest.fn();

jest.mock('../secrets', () => ({ doInDbContext: doInDbContextMock }));
jest.mock('../logging', () => ({ Logger: { get: jest.fn(() => loggerMock) } }));
jest.mock('../sentry.context', () => ({ wrapLambdaHandler: wrapLambdaHandlerMock }));
jest.mock('../aggregatedActivityLoop/aggregated_activity', () => ({ updateAggregatedActivity: updateAggregatedActivityMock }));

import { handler } from '../aggregatedActivityLoop/index';
import { MemesSeason } from '../entities/ISeason';
import {
  AggregatedActivity,
  AggregatedActivityMemes,
  ConsolidatedAggregatedActivity,
  ConsolidatedAggregatedActivityMemes
} from '../entities/IAggregatedActivity';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ACTIVITY_RESET;
});

describe('handler', () => {
  test.each([
    ['true', true],
    [undefined, false]
  ])('calls updateAggregatedActivity(%s)', async (flag, expected) => {
    if (flag) process.env.ACTIVITY_RESET = flag as string;
    doInDbContextMock.mockImplementation(async (fn, opts) => {
      await fn();
      return opts;
    });

    await handler();

    expect(wrapLambdaHandlerMock).toHaveBeenCalledTimes(1);
    expect(typeof wrapLambdaHandlerMock.mock.calls[0][0]).toBe('function');
    expect(doInDbContextMock).toHaveBeenCalledTimes(1);
    expect(updateAggregatedActivityMock).toHaveBeenCalledWith(expected);

    const options = doInDbContextMock.mock.calls[0][1];
    expect(options.logger).toBe(loggerMock);
    expect(options.entities).toEqual([
      MemesSeason,
      AggregatedActivity,
      ConsolidatedAggregatedActivity,
      AggregatedActivityMemes,
      ConsolidatedAggregatedActivityMemes
    ]);
  });
});

