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
import { wrapLambdaHandler } from '@/sentry.context';
import { XTdhIdentitySnapshotChangedError } from '@/xtdh/xtdh-identity-snapshot-changed-error';
import {
  enrichXTdhSentryEvent,
  shouldCaptureXTdhError
} from '@/xTdhLoop/xtdh-retry-reporting';

it('configures conflict reporting only on the xTDH handler', () => {
  expect(wrapLambdaHandler).toHaveBeenCalledWith(expect.any(Function), {
    shouldCaptureException: shouldCaptureXTdhError,
    enrichEvent: enrichXTdhSentryEvent
  });
});

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

  it('accepts queued messages from the retired producer and preserves SNS message groups', () => {
    expect(
      resolveXTdhLoopWork({
        Records: [
          {
            body: JSON.stringify({
              Type: 'Notification',
              Message: JSON.stringify({
                randomId: 'sns-message',
                membership_cycle_id: 'tdh-full:cycle-1'
              })
            })
          }
        ]
      })
    ).toEqual({
      phase: XTDH_LOOP_PHASE.UNIVERSE,
      messageGroupId: 'sns-message'
    });
    expect(
      resolveXTdhLoopWork({
        Records: [
          {
            body: JSON.stringify({
              phase: XTDH_LOOP_PHASE.STATS,
              membership_cycle_id: 'tdh-full:cycle-1'
            })
          }
        ]
      })
    ).toEqual({
      phase: XTDH_LOOP_PHASE.STATS
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

  it.each([1, 2, 3, 4, 5, undefined])(
    'rejects the original conflict for SQS retry at attempt %s',
    async (count) => {
      const error = new XTdhIdentitySnapshotChangedError();
      mockHandleUniversePhase.mockRejectedValueOnce(error);
      await expect(
        handler(
          {
            Records: [
              {
                body: '{}',
                attributes: {
                  ApproximateReceiveCount: count?.toString()
                }
              }
            ]
          },
          { awsRequestId: 'retry-request' } as any,
          jest.fn()
        )
      ).rejects.toBe(error);
      expect(error.receiveCount).toBe(count);
      expect(shouldCaptureXTdhError(error)).toBe(
        count === undefined || count >= 5
      );
      if (count !== undefined && count < 5) {
        expect(mockLoggerWarn).toHaveBeenCalledWith(
          'xTDH identity snapshot changed; SQS will retry',
          { aws_request_id: 'retry-request', receive_count: count }
        );
      } else {
        expect(mockLoggerWarn).not.toHaveBeenCalled();
      }
      expect(mockHandleStatsPhase).not.toHaveBeenCalled();
    }
  );

  it('keeps unrelated failures reportable and rejects the invocation', async () => {
    const error = new Error('database unavailable');
    mockHandleUniversePhase.mockRejectedValueOnce(error);
    await expect(handler({}, {} as any, jest.fn())).rejects.toBe(error);
    expect(shouldCaptureXTdhError(error)).toBe(true);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});
