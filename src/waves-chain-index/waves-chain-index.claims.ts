import { appFeatures } from '@/app-features';
import { Logger } from '@/logging';
import { sqs } from '@/sqs';
import { ChainEvent, ObjectInfo } from './waves-chain-index.events';

/**
 * Claim builds for the Main Stage: the chain has no Main Stage designation
 * yet, so MAIN_STAGE_DECISION_IDS names its decisions. When the event log
 * records a decided RESULT_FINAL of one of them, the index queues one claim
 * build on the claims-builder queue for the result's rank-1 entry, with the
 * result's reference in `chain`. The claim builder rereads the result on
 * the gateway before it builds anything.
 *
 * Exactly one a (network, decision, occurrence): the build is written to
 * chain_claim_builds in the transaction that writes the block's events
 * (never twice: a replayed or rebuilt log finds it there), and sent after
 * that commits, each run retrying what is still pending (an outbox). A
 * run that stops between a send and its row's update sends that one again
 * on the next run; the claim builder builds one claim a drop.
 *
 * Before a build is sent, the winner's artwork collaboration is frozen for
 * the mint (ClaimBuildPort.freezeCollaboration), as 6529.io's runtime does
 * when it decides a Main Stage winner: the claim builder needs its credit
 * snapshot. The chain mirror's write of the result freezes it too and finds
 * it frozen.
 */

const logger = Logger.get('WAVES_CHAIN_CLAIM_BUILDS');

const HEX_ID = /^0x[0-9a-f]{64}$/;

/** The chain's reference to a result, as the claim builder takes it. */
export interface ChainClaimContext {
  readonly decision_id: string;
  readonly occurrence: number;
  readonly entry_id: string;
  readonly height: number;
  readonly manifest_hash: string;
}

/** The claims-builder message (no `competition`: see claimBuildsOf). */
export interface ClaimBuildMessage {
  readonly drop_id: string;
  readonly chain: ChainClaimContext;
}

/** A claim build the log called for: a row of chain_claim_builds. */
export interface ClaimBuild {
  readonly network: string;
  readonly decisionId: string;
  readonly occurrence: number;
  readonly height: number;
  readonly entryId: string;
  readonly dropId: string | null;
  /** null: nothing to send (`reason` says why). */
  readonly message: ClaimBuildMessage | null;
  readonly status: 'pending' | 'skipped';
  readonly reason: string | null;
}

const loggedOnce = new Set<string>();

function logOnce(key: string, message: string) {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  logger.warn(message);
}

/**
 * MAIN_STAGE_DECISION_IDS: comma-separated chain decision ids, each `0x`
 * and 64 hex digits, read in lowercase as the mint log's claim build reads
 * them (src/mint-log/mint-claim-build.ts); empty, none. One of another
 * form is logged once and left out.
 */
export function parseMainStageDecisionIds(
  value: string | undefined | null
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const part of (value ?? '').split(',')) {
    const id = part.trim().toLowerCase();
    if (!id) continue;
    if (HEX_ID.test(id)) ids.add(id);
    else {
      logOnce(
        `setting:${id}`,
        `[MAIN_STAGE_DECISION_IDS] "${id}" is not 0x and 64 hex digits: left out`
      );
    }
  }
  return ids;
}

function hexId(value: unknown): string | null {
  return typeof value === 'string' && HEX_ID.test(value) ? value : null;
}

/**
 * The claim builds these events call for: one for each decided
 * RESULT_FINAL of a Main Stage decision, for its rank-1 winner. `drop_id`
 * is the entry's 6529.io drop id, its legacy id (the imported drop's
 * UUID); an entry created on the chain has no 6529.io drop yet, so nothing
 * is sent for it. `height` is the block the result went final in (it stays
 * final from there). `competition` is left out: the index can't name
 * 6529.io's competition ids.
 */
export function claimBuildsOf(
  events: readonly ChainEvent[],
  mainStage: ReadonlySet<string>,
  network: string | null
): ClaimBuild[] {
  const out: ClaimBuild[] = [];
  for (const event of events) {
    if (event.kind !== 'RESULT_FINAL' || event.data.status !== 'decided') {
      continue;
    }
    const decisionId = event.decisionId;
    const occurrence = event.data.occurrence;
    if (!decisionId || !mainStage.has(decisionId)) continue;
    if (typeof occurrence !== 'number' || !Number.isSafeInteger(occurrence)) {
      logOnce(
        `occurrence:${decisionId}:${event.height}`,
        `[CLAIM BUILD] decision ${decisionId} at ${event.height}: a result without its occurrence`
      );
      continue;
    }
    const winners = Array.isArray(event.data.winners)
      ? (event.data.winners as Record<string, unknown>[])
      : [];
    const first = winners.find((winner) => winner.rank === 1);
    const entryId = hexId(first?.entryId);
    if (!entryId) {
      logOnce(
        `winner:${decisionId}:${occurrence}`,
        `[CLAIM BUILD] decision ${decisionId} occurrence ${occurrence}: decided with no rank-1 entry`
      );
      continue;
    }
    const dropId =
      typeof first?.legacyId === 'string' && first.legacyId
        ? first.legacyId
        : null;
    const manifestHash = hexId(first?.manifestHash);
    const reason = !dropId
      ? 'entry created on the chain: no 6529.io drop'
      : !manifestHash
        ? 'no manifest hash'
        : null;
    if (reason) {
      logOnce(
        `skip:${decisionId}:${occurrence}`,
        `[CLAIM BUILD] decision ${decisionId} occurrence ${occurrence}, entry ${entryId}: ${reason}; nothing sent`
      );
    }
    out.push({
      network: network ?? '',
      decisionId,
      occurrence,
      height: event.height,
      entryId,
      dropId,
      message: reason
        ? null
        : {
            drop_id: dropId!,
            chain: {
              decision_id: decisionId,
              occurrence,
              entry_id: entryId,
              height: event.height,
              manifest_hash: manifestHash!
            }
          },
      status: reason ? 'skipped' : 'pending',
      reason
    });
  }
  return out;
}

/**
 * A final result as the index holds it (the chain API's Result), with its
 * winners' entries, as the RESULT_FINAL event the log writes for it: the
 * block it went final in (settledHeight), each winner with its 6529.io
 * legacy id and manifest hash. Null, to wait for a later run, while the
 * rank-1 winner's entry or its manifest hash isn't in the index yet, or
 * the result names no block it went final in.
 */
export function resultFinalEventOf(
  decisionId: string,
  result: Record<string, unknown>,
  entries: ReadonlyMap<string, ObjectInfo>
): ChainEvent | null {
  const height = Number(result.settledHeight);
  if (!Number.isSafeInteger(height) || height <= 0) return null;
  const winners = (
    Array.isArray(result.winners) ? result.winners : []
  ) as Record<string, unknown>[];
  const first = winners.find((winner) => Number(winner.rank) === 1);
  const firstId = hexId(String(first?.entryId ?? '').toLowerCase());
  if (!firstId || !hexId(entries.get(firstId)?.manifestHash ?? null)) {
    return null;
  }
  return {
    height,
    seq: 0,
    blockTime: 0,
    kind: 'RESULT_FINAL',
    origin: 'OPERATION',
    waveId: null,
    waveLegacyId: null,
    decisionId,
    decisionLegacyId: null,
    entryId: null,
    entryLegacyId: null,
    pollId: null,
    pollLegacyId: null,
    groupId: null,
    groupLegacyId: null,
    actor: null,
    data: {
      resultTime: Number(result.resultTime),
      occurrence: result.occurrence,
      status: result.status,
      winnerCount: winners.length,
      winners: winners.map((winner) => {
        const entryId = String(winner.entryId ?? '').toLowerCase();
        const entry = entries.get(entryId);
        return {
          entryId,
          rank: Number(winner.rank),
          score: winner.score ?? null,
          legacyId: entry?.legacyId ?? null,
          manifestHash: entry?.manifestHash ?? null
        };
      }),
      settledHeight: height
    }
  };
}

/** What the index needs to queue claim builds; tests give their own. */
export interface ClaimBuildPort {
  enabled(): boolean;
  mainStage(): ReadonlySet<string>;
  /**
   * Freezes the winner's artwork collaboration for the mint, before its
   * claim build is sent: its credit snapshot taken and its pending
   * invitations closed, as 6529.io's runtime does when it decides a Main
   * Stage winner (freezeMemeCollaborationForNativeDecision). The claim
   * builder refuses a collaboration without that snapshot. Idempotent: a
   * frozen collaboration, or a drop with none, is left as it is. Throws
   * when it fails (nothing is sent; tried again next run). Without it,
   * nothing is frozen here.
   */
  freezeCollaboration?(dropId: string): Promise<void>;
  /** Sends a message; its id. Throws when the send fails. */
  send(message: ClaimBuildMessage): Promise<string | null>;
}

export const claimBuildQueue: ClaimBuildPort = {
  enabled: () => appFeatures.isWavesChainClaimBuildsEnabled(),
  mainStage: () =>
    parseMainStageDecisionIds(process.env.MAIN_STAGE_DECISION_IDS),
  async freezeCollaboration(dropId) {
    // Loaded only when a claim is due: it brings 6529.io's collaboration
    // service. MAIN_STAGE_DECISION_IDS is the Main Stage's designation
    // here, as it is for the claim builder.
    const [{ memeCollaborationsService }, { dbSupplier }] = await Promise.all([
      import('@/meme-collaborations/meme-collaborations.service'),
      import('@/sql-executor')
    ]);
    await dbSupplier().executeNativeQueriesInTransaction((connection) =>
      memeCollaborationsService.freezeForMint(dropId, { connection })
    );
  },
  async send(message) {
    const queue = process.env.CLAIMS_BUILDER_SQS_URL;
    if (!queue) throw new Error('CLAIMS_BUILDER_SQS_URL is not configured');
    const response = await sqs.send({ queue, message });
    logger.info(
      `[CLAIM BUILD QUEUED] drop_id=${message.drop_id} decision=${message.chain.decision_id} occurrence=${message.chain.occurrence} messageId=${response.MessageId}`
    );
    return response.MessageId ?? null;
  }
};
