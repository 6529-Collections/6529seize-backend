const mockDoInDbContext = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockHandleUniversePhase = jest.fn();
const mockHandleStatsPhase = jest.fn();

jest.mock('../secrets', () => ({
  doInDbContext: mockDoInDbContext
}));

jest.mock('../sentry.context', () => ({
  wrapLambdaHandler: jest.fn((handler) => handler)
}));

jest.mock('../logging', () => ({
  Logger: {
    get: jest.fn(() => ({
      info: mockLoggerInfo,
      warn: mockLoggerWarn
    }))
  }
}));

jest.mock('../xtdh/recalculate-xtdh.use-case', () => ({
  recalculateXTdhUseCase: {
    handleUniversePhase: mockHandleUniversePhase,
    handleStatsPhase: mockHandleStatsPhase
  }
}));

import { handler, resolveXTdhLoopPhase, resolveXTdhLoopWork } from './index';
import { XTDH_LOOP_PHASE } from '../xtdh/xtdh-loop-phase';

describe('xTdhLoop handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDoInDbContext.mockImplementation(async (fn) => fn());
    mockHandleUniversePhase.mockResolvedValue(undefined);
    mockHandleStatsPhase.mockResolvedValue(undefined);
  });

  it('treats empty and legacy messages as universe phase', () => {
    expect(resolveXTdhLoopPhase({})).toBe(XTDH_LOOP_PHASE.UNIVERSE);
    expect(
      resolveXTdhLoopPhase({
        Records: [{ body: JSON.stringify({}) }]
      })
    ).toBe(XTDH_LOOP_PHASE.UNIVERSE);
  });

  it('resolves stats messages to stats phase', () => {
    expect(resolveXTdhLoopPhase({ phase: XTDH_LOOP_PHASE.STATS })).toBe(
      XTDH_LOOP_PHASE.STATS
    );
    expect(
      resolveXTdhLoopPhase({
        Records: [{ body: JSON.stringify({ phase: XTDH_LOOP_PHASE.STATS }) }]
      })
    ).toBe(XTDH_LOOP_PHASE.STATS);
  });

  it('extracts FIFO message group id from universe messages', () => {
    expect(
      resolveXTdhLoopWork({
        Records: [
          {
            attributes: { MessageGroupId: 'tdh-fifo-group' },
            body: JSON.stringify({ type: 'tdh-complete' })
          }
        ]
      })
    ).toEqual({
      phase: XTDH_LOOP_PHASE.UNIVERSE,
      messageGroupId: 'tdh-fifo-group'
    });
    expect(
      resolveXTdhLoopWork({
        Records: [{ body: JSON.stringify({ randomId: 'sns-body-id' }) }]
      })
    ).toEqual({
      phase: XTDH_LOOP_PHASE.UNIVERSE,
      messageGroupId: 'sns-body-id'
    });
  });

  it('warns when a mixed SQS batch is observed', () => {
    expect(
      resolveXTdhLoopWork({
        Records: [
          { body: JSON.stringify({ phase: XTDH_LOOP_PHASE.STATS }) },
          {
            attributes: { MessageGroupId: 'tdh-fifo-group' },
            body: JSON.stringify({ type: 'tdh-complete' })
          }
        ]
      })
    ).toEqual({
      phase: XTDH_LOOP_PHASE.UNIVERSE,
      messageGroupId: 'tdh-fifo-group'
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Mixed xTDH loop SQS batch observed; processing universe phase and relying on batchSize: 1 to avoid dropping stats work.'
    );
  });

  it('runs the universe phase for non-stats SQS messages', async () => {
    await handler(
      {
        Records: [
          {
            attributes: { MessageGroupId: 'tdh-fifo-group' },
            body: JSON.stringify({ type: 'tdh-complete' })
          }
        ]
      },
      {} as any,
      jest.fn()
    );

    expect(mockHandleUniversePhase).toHaveBeenCalledWith(
      expect.objectContaining({ timer: expect.any(Object) }),
      { messageGroupId: 'tdh-fifo-group' }
    );
    expect(mockHandleStatsPhase).not.toHaveBeenCalled();
  });

  it('runs only the stats phase for stats SQS messages', async () => {
    await handler(
      {
        Records: [{ body: JSON.stringify({ phase: XTDH_LOOP_PHASE.STATS }) }]
      },
      {} as any,
      jest.fn()
    );

    expect(mockHandleStatsPhase).toHaveBeenCalledTimes(1);
    expect(mockHandleUniversePhase).not.toHaveBeenCalled();
  });
});
