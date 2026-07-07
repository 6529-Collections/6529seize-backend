import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';
import { RequestContext } from '../request.context';
import { Timer } from '../time';
import { recalculateXTdhUseCase } from '../xtdh/recalculate-xtdh.use-case';
import {
  isXTdhLoopPhase,
  XTDH_LOOP_PHASE,
  XTdhLoopPhase
} from '../xtdh/xtdh-loop-phase';

const logger = Logger.get('XTDH_LOOP');

type SqsRecord = Record<string, unknown>;

interface XTdhLoopWork {
  readonly phase: XTdhLoopPhase;
  readonly messageGroupId?: string;
}

export function resolveXTdhLoopPhase(event: unknown): XTdhLoopPhase {
  return resolveXTdhLoopWork(event).phase;
}

export function resolveXTdhLoopWork(event: unknown): XTdhLoopWork {
  const records = getSqsRecords(event);
  if (!records.length) {
    return {
      phase: getPhaseFromMessage(event),
      messageGroupId: getMessageGroupIdFromMessage(event)
    };
  }
  // The event source is configured with batchSize: 1. If that changes and a
  // mixed batch arrives, prefer the universe phase so it can enqueue fresh stats.
  const hasUniverseMessage = records.some(
    (record) => getPhaseFromRecord(record) !== XTDH_LOOP_PHASE.STATS
  );
  if (hasUniverseMessage) {
    const hasStatsMessage = records.some(
      (record) => getPhaseFromRecord(record) === XTDH_LOOP_PHASE.STATS
    );
    if (hasStatsMessage) {
      logger.warn(
        `Mixed xTDH loop SQS batch observed; processing universe phase and relying on batchSize: 1 to avoid dropping stats work.`
      );
    }
    const universeRecord = records.find(
      (record) => getPhaseFromRecord(record) !== XTDH_LOOP_PHASE.STATS
    );
    return {
      phase: XTDH_LOOP_PHASE.UNIVERSE,
      messageGroupId: universeRecord
        ? getMessageGroupIdFromRecord(universeRecord)
        : undefined
    };
  }
  return {
    phase: XTDH_LOOP_PHASE.STATS
  };
}

function getSqsRecords(event: unknown): SqsRecord[] {
  if (!isRecord(event) || !Array.isArray(event.Records)) {
    return [];
  }
  return event.Records.filter(isRecord);
}

function getPhaseFromRecord(record: SqsRecord): XTdhLoopPhase {
  return getPhaseFromMessage(getMessageFromRecord(record));
}

function getMessageFromRecord(record: SqsRecord): unknown {
  return typeof record.body === 'string' ? parseJsonOrNull(record.body) : null;
}

function getMessageGroupIdFromRecord(record: SqsRecord): string | undefined {
  const attributes = record.attributes;
  if (isRecord(attributes) && typeof attributes.MessageGroupId === 'string') {
    return attributes.MessageGroupId;
  }
  return getMessageGroupIdFromMessage(getMessageFromRecord(record));
}

function parseJsonOrNull(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getPhaseFromMessage(message: unknown): XTdhLoopPhase {
  if (!isRecord(message)) {
    return XTDH_LOOP_PHASE.UNIVERSE;
  }
  return isXTdhLoopPhase(message.phase)
    ? message.phase
    : XTDH_LOOP_PHASE.UNIVERSE;
}

function getMessageGroupIdFromMessage(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  if (typeof message.message_group_id === 'string') {
    return message.message_group_id;
  }
  return typeof message.randomId === 'string' ? message.randomId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const handler = sentryContext.wrapLambdaHandler(
  async (event, lambdaContext) => {
    await doInDbContext(
      async () => {
        const work = resolveXTdhLoopWork(event);
        const getRemainingTimeInMillis =
          typeof lambdaContext?.getRemainingTimeInMillis === 'function'
            ? () => lambdaContext.getRemainingTimeInMillis()
            : undefined;
        const ctx: RequestContext = {
          timer: new Timer('XTDH_LOOP')
        };
        logger.info(`Loop phase ${work.phase} started`);
        if (work.phase === XTDH_LOOP_PHASE.STATS) {
          await recalculateXTdhUseCase.handleStatsPhase(ctx);
        } else {
          await recalculateXTdhUseCase.handleUniversePhase(ctx, {
            messageGroupId: work.messageGroupId,
            ...(getRemainingTimeInMillis ? { getRemainingTimeInMillis } : {})
          });
        }
        logger.info(
          `Loop phase ${work.phase} finished ${JSON.stringify(ctx?.timer)}`
        );
      },
      {
        logger
      }
    );
  }
);
