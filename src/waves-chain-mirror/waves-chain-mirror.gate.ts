import {
  CONTENT_MODERATION_REJECTION_CODE,
  PrePublicationModerationService,
  prePublicationModerationService
} from '@/content-moderation/pre-publication-moderation.service';
import { CustomApiCompliantException } from '@/exceptions';
import { stableUuid } from '@/competitions/competition-id';
import { Logger } from '@/logging';
import { NativeEntryContent } from './waves-chain-mirror.native-entries';

const logger = Logger.get('WAVES_CHAIN_MIRROR_GATE');

/**
 * 6529.io's pre-publication moderation for an entry made on the chain, as
 * its create path runs it for a new drop: the author's suspension, the
 * deterministic screen and, on a signal, the evaluator.
 *
 * - allowed: the content may be shown.
 * - refused: moderation refused the content itself
 *   (CONTENT_MODERATION_REJECTED); the mirror holds the entry for good.
 * - deferred: anything that is not a verdict on the content (the author
 *   suspended, the evaluator's hourly limit, an error): the mirror asks
 *   again later, waiting longer each time.
 */
export type GateVerdict =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'deferred'; readonly code: string };

export interface ContentGate {
  check(input: {
    readonly dropId: string;
    readonly authorProfileId: string;
    readonly waveId: string;
    readonly content: NativeEntryContent;
  }): Promise<GateVerdict>;
}

/**
 * The moderation tables' drop_id width. When the column-widening change
 * widens them to 100, this becomes 100 and a drop's own id is used.
 */
export const MODERATION_DROP_ID_MAX = 50;

/** The UUIDv5 namespace of moderation subjects for drops with a chain id. */
const NS_CHAIN_MODERATION = 'd1a6a3c2-58a4-4f0e-b7a1-5f0b6f7e2c91';

/**
 * The drop id moderation keeps its checks and reviews under: a drop's own
 * id, or for one 6529.io's moderation tables can't hold (drop_id is
 * varchar(50); a drop made on the chain has its 66-character chain id) a
 * UUIDv5 of it. Without it every check failed to record, and the entry was
 * held as if moderation were unavailable.
 */
export function moderationSubjectId(dropId: string): string {
  return dropId.length <= MODERATION_DROP_ID_MAX
    ? dropId
    : stableUuid(NS_CHAIN_MODERATION, dropId.toLowerCase());
}

export class ModerationContentGate implements ContentGate {
  constructor(
    private readonly moderation: Pick<
      PrePublicationModerationService,
      'evaluate'
    > = prePublicationModerationService
  ) {}

  async check(input: {
    readonly dropId: string;
    readonly authorProfileId: string;
    readonly waveId: string;
    readonly content: NativeEntryContent;
  }): Promise<GateVerdict> {
    try {
      await this.moderation.evaluate(
        {
          dropId: moderationSubjectId(input.dropId),
          authorProfileId: input.authorProfileId,
          waveId: input.waveId,
          operation: 'CREATE',
          title: input.content.title,
          parts: input.content.parts.map((part) => ({ content: part.content }))
        },
        {}
      );
      return { kind: 'allowed' };
    } catch (error) {
      if (
        error instanceof CustomApiCompliantException &&
        error.code === CONTENT_MODERATION_REJECTION_CODE
      ) {
        return { kind: 'refused', code: error.code };
      }
      const code =
        error instanceof CustomApiCompliantException && error.code
          ? error.code
          : 'MODERATION_UNAVAILABLE';
      logger.warn(
        `[WAVES CHAIN MIRROR] entry ${input.dropId}: moderation gave no verdict (${code}): ${error}`
      );
      return { kind: 'deferred', code };
    }
  }
}
