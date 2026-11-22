import { DEVICE_SIGNATURE_MAX_CLOCK_SKEW_MS } from '@/api/device-signing/device-signed-writes.service';
import {
  updateSubscribeAllEditions,
  updateSubscription,
  updateSubscriptionCount,
  updateSubscriptionMode
} from '@/api/subscriptions/api.subscriptions.db';
import {
  ApiCompliantException,
  CustomApiCompliantException
} from '@/exceptions';
import { Logger } from '@/logging';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { RequestContext } from '@/request.context';
import { markSubscriptionCoverageDirty } from '@/subscription-coverage/subscription-coverage-dirty';
import {
  RecordAnchor,
  recordAnchorService
} from '@/signed-records/record-anchor';
import { decodeSignedRecordsHeader } from '@/signed-records/record-event';
import { isPrincipalId } from '@/signed-records/record-families';
import { deviceGrantRecordSource } from '@/signed-records/record-grants';
import {
  RecordHeadStore,
  RecordIndexer,
  RecordRegistry,
  SenderKeyring
} from '@/signed-records/record-index';
import { RecordKind } from '@/signed-records/record-kinds';
import { recordLog } from '@/signed-records/record-log/record-log';
import type { RecordLogWriter } from '@/signed-records/record-log/record-log.service';
import { recordOwnerDirectory } from '@/signed-records/record-owner-directory';
import {
  PrincipalBindingSource,
  RecordGrantSource,
  verifyRecordEvent,
  VerifiedRecord
} from '@/signed-records/record-verify';
import { signedRecordHeadsDb } from '@/signed-records/signed-record-heads.db';
import {
  ChoiceEffects,
  ChoiceScope,
  makeChoice
} from '../identity/identity-choices';
import {
  IdentityDirectory,
  mirrorIdentityDirectory
} from '../identity/identity-directory';
import {
  SubscriptionWritePath,
  subscriptionWritePathNow
} from '../identity/identity-switch';
import { identityOfRouteKey } from '../identity/subscription-tables';
import { msToDbText } from '../opening/legacy-tables';
import {
  journal,
  journalBefore,
  JOURNAL_LANE,
  JournalSelection
} from '../timeline/journal';
import { ComparisonReport, saveReport } from '../writers/identity-reports';
import {
  compareShadowChange,
  failedShadowReport,
  legacyLogMark
} from './shadow-record-check';
import {
  changeOfRecord,
  recordContentOf,
  SubscriptionChange,
  SubscriptionRecordType
} from './subscription-records';

const logger = Logger.get('SUBSCRIPTION_RECORDS');

/*
 * A person's subscription change (mode, all editions, a card, a count) as
 * the four write routes take it, on the path the switch state gives at the
 * moment of the write (identity-switch.ts, subscriptionWritePathNow):
 *
 * - PAUSED: 503, nothing written.
 * - LEGACY: today's write; a signed record that came with it is ignored.
 * - SHADOW: today's write first, with its own refusals. A signed record
 *   that came with it is then verified and applied to the identity tables,
 *   and the two sides are compared; nothing on the identity side can fail
 *   the request, and every outcome is a RECORD report.
 * - IDENTITY: the change needs a signed record. It is verified, applied to
 *   the identity tables, and logged (the signed event with its grant proof,
 *   then the change's journal entry, kind `choice`), all in one
 *   transaction; then it is written to the legacy tables (the rollback copy)
 *   under the identity's consolidation key. A failed legacy write is logged
 *   and does not fail the request.
 *
 * In shadow the record is applied and logged the same way. A rebuild
 * writes the change back from its journal entry, as it does every other
 * write to the identity tables.
 */

/** What a route hands over, after its own checks (auth, body, released card). */
export interface SubscriptionWriteRequest {
  /** The route's key, lowercase. */
  readonly routeKey: string;
  /** The signed-in wallet. */
  readonly wallet: string;
  /** The `x-6529-signed-records` header as sent, if any. */
  readonly signedRecords: string | undefined;
  readonly change: SubscriptionChange;
}

/** Today's response shapes, by change. */
export type SubscriptionWriteResponse =
  | { consolidation_key: string; automatic: boolean }
  | { consolidation_key: string; subscribe_all_editions: boolean }
  | {
      consolidation_key: string;
      contract: string;
      token_id: number;
      subscribed: boolean;
      subscribed_count: number;
    }
  | {
      consolidation_key: string;
      contract: string;
      token_id: number;
      count: number;
    };

/** Today's write of a change to the legacy tables, under a consolidation key. */
export type LegacySubscriptionWrite = (
  consolidationKey: string,
  change: SubscriptionChange
) => Promise<SubscriptionWriteResponse>;

export const legacySubscriptionWrite: LegacySubscriptionWrite = (
  consolidationKey,
  change
) => {
  switch (change.type) {
    case 'subs.mode':
      return updateSubscriptionMode(consolidationKey, change.automatic);
    case 'subs.all-editions':
      return updateSubscribeAllEditions(consolidationKey, change.all);
    case 'subs.card':
      return updateSubscription(
        consolidationKey,
        change.contract,
        change.tokenId,
        change.subscribed
      );
    case 'subs.count':
      return updateSubscriptionCount(
        consolidationKey,
        change.contract,
        change.tokenId,
        change.count
      );
  }
};

export interface SubscriptionWriteDeps {
  readonly path: () => Promise<SubscriptionWritePath>;
  readonly grants: RecordGrantSource;
  readonly bindings: PrincipalBindingSource;
  readonly anchors: { getAnchor(): Promise<RecordAnchor> };
  readonly directory: IdentityDirectory;
  /** Where the signed event goes, with its grant proof (lane `subs`). */
  readonly log: Pick<RecordLogWriter, 'appendEvents'>;
  readonly heads: RecordHeadStore;
  readonly legacy: LegacySubscriptionWrite;
  readonly saveReport: (report: ComparisonReport) => Promise<void>;
  readonly now: () => number;
}

const defaultDeps = (): SubscriptionWriteDeps => ({
  path: () => subscriptionWritePathNow(),
  grants: deviceGrantRecordSource,
  bindings: recordOwnerDirectory,
  anchors: recordAnchorService,
  directory: mirrorIdentityDirectory,
  log: recordLog,
  heads: signedRecordHeadsDb,
  legacy: legacySubscriptionWrite,
  saveReport,
  now: () => Date.now()
});

const INVALID_SIGNED_RECORD = 'INVALID_SIGNED_RECORD';

class InvalidSignedRecordException extends CustomApiCompliantException {
  constructor(
    readonly reason: string,
    detail: string
  ) {
    super(400, `Invalid signed record: ${detail}`, INVALID_SIGNED_RECORD, {
      reason
    });
  }
}

const COVERAGE_REASON: Record<SubscriptionRecordType, string> = {
  'subs.mode': 'MODE_CHANGED',
  'subs.all-editions': 'EDITION_PREFERENCE_CHANGED',
  'subs.card': 'SELECTION_CHANGED',
  'subs.count': 'QUANTITY_CHANGED'
};

/** A verified record that states the request's change, and whose it is. */
interface CheckedRecord {
  readonly record: VerifiedRecord;
  readonly change: SubscriptionChange;
  readonly identityKey: string;
  readonly consolidationKey: string;
}

/** Why a shadow companion did not apply, as a code for its report. */
function causeOf(error: unknown): string {
  if (error instanceof InvalidSignedRecordException) {
    return `invalid-record:${error.reason}`;
  }
  if (error instanceof ApiCompliantException) {
    return `refused:${error.code ?? error.getStatusCode()}`;
  }
  return 'error';
}

export class SubscriptionChangeWriter {
  constructor(private readonly deps: SubscriptionWriteDeps = defaultDeps()) {}

  async write(
    request: SubscriptionWriteRequest
  ): Promise<SubscriptionWriteResponse> {
    switch (await this.pathNow()) {
      case 'PAUSED':
        throw new CustomApiCompliantException(
          503,
          'Subscription changes are paused for a few minutes. Try again shortly.'
        );
      case 'LEGACY':
        return this.deps.legacy(request.routeKey, request.change);
      case 'SHADOW':
        return this.shadow(request);
      case 'IDENTITY':
        return this.identity(request);
    }
  }

  /** A state that can't be read refuses the write rather than guess. */
  private async pathNow(): Promise<SubscriptionWritePath> {
    try {
      return await this.deps.path();
    } catch (error) {
      logger.error('[WRITE PATH UNKNOWN] [CHANGE REFUSED AS PAUSED]', error);
      return 'PAUSED';
    }
  }

  private async identity(
    request: SubscriptionWriteRequest
  ): Promise<SubscriptionWriteResponse> {
    if (!request.signedRecords) {
      throw new CustomApiCompliantException(
        409,
        'Subscription changes are signed now. Update the app and try again.',
        'SIGNED_RECORD_REQUIRED'
      );
    }
    const checked = await this.check(request, request.signedRecords);
    const effects = await this.apply(checked);
    try {
      await this.deps.legacy(checked.consolidationKey, checked.change);
    } catch (error) {
      // The legacy write marks coverage after its own transaction; it did
      // not get there, so mark it here.
      logger.error(
        `[LEGACY DUAL WRITE FAILED] [${checked.change.type}] [event ${checked.record.event.id}]`,
        error
      );
      try {
        await markSubscriptionCoverageDirty(
          [checked.consolidationKey],
          COVERAGE_REASON[checked.change.type]
        );
      } catch (markError) {
        logger.error('[COVERAGE MARKER FAILED]', markError);
      }
    }
    return responseOf(request.routeKey, checked.change, effects);
  }

  private async shadow(
    request: SubscriptionWriteRequest
  ): Promise<SubscriptionWriteResponse> {
    const header = request.signedRecords;
    const mark = header ? await this.readLegacyLogMark(request.routeKey) : null;
    const response = await this.deps.legacy(request.routeKey, request.change);
    if (header) {
      await this.shadowCompanion(request, header, mark);
    }
    return response;
  }

  /** The legacy log's last id, or null (lines are then not compared). */
  private async readLegacyLogMark(routeKey: string): Promise<number | null> {
    try {
      return await legacyLogMark(routeKey);
    } catch (error) {
      logger.error('[SHADOW LOG MARK FAILED]', error);
      return null;
    }
  }

  /** Never throws: the person's change is already saved. */
  private async shadowCompanion(
    request: SubscriptionWriteRequest,
    header: string,
    mark: number | null
  ): Promise<void> {
    let report: ComparisonReport;
    let eventId: string | null = null;
    try {
      const checked = await this.check(request, header);
      eventId = checked.record.event.id;
      const effects = await this.apply(checked);
      report = await compareShadowChange({
        routeKey: request.routeKey,
        change: checked.change,
        effects,
        legacyLogMark: mark,
        eventId
      });
    } catch (error) {
      const cause = causeOf(error);
      if (cause === 'error') {
        logger.error(
          `[SHADOW RECORD FAILED] [${request.change.type}] [event ${eventId ?? '-'}]`,
          error
        );
      }
      report = failedShadowReport(request.change, cause, eventId);
    }
    if (report.verdict !== 'MATCH') {
      logger.warn(
        `[SHADOW RECORD DIFF] [${report.notes.join('] [')}] ${report.diffs.map((diff) => diff.key).join(', ')}`
      );
    }
    try {
      await this.deps.saveReport(report);
    } catch (error) {
      logger.error('[SHADOW RECORD REPORT NOT SAVED]', error);
    }
  }

  /**
   * Verifies the header's one record (grant, signature, anchor, and that
   * its author is bound to its owner at the anchor) and checks it states
   * this request: a `ps` RECORD of the request's type, key and body, by the
   * signed-in wallet, for the identity the route's key names.
   */
  private async check(
    request: SubscriptionWriteRequest,
    header: string
  ): Promise<CheckedRecord> {
    let events;
    try {
      events = decodeSignedRecordsHeader(header);
    } catch (error) {
      throw new InvalidSignedRecordException(
        'header',
        error instanceof Error ? error.message : String(error)
      );
    }
    if (events.length !== 1) {
      throw new InvalidSignedRecordException(
        'header',
        'a subscription change carries exactly one record'
      );
    }
    const anchor = await this.deps.anchors.getAnchor();
    const result = await verifyRecordEvent(events[0], {
      grants: this.deps.grants,
      bindings: this.deps.bindings,
      live: {
        now: this.deps.now(),
        head: anchor.anchor,
        maxAnchorLag: anchor.maxAnchorLag,
        maxClockSkewMs: DEVICE_SIGNATURE_MAX_CLOCK_SKEW_MS
      }
    });
    if (!result.ok) {
      throw new InvalidSignedRecordException(result.reason, result.detail);
    }
    const record = result.record;
    const parsed = record.parsed;
    if (parsed.kind !== RecordKind.RECORD || record.family !== 'ps') {
      throw new InvalidSignedRecordException(
        'kind',
        'a subscription change is a RECORD in the ps family'
      );
    }
    let change: SubscriptionChange;
    try {
      change = changeOfRecord(parsed.type, parsed.key, parsed.body);
    } catch (error) {
      throw new InvalidSignedRecordException(
        'invalid-change',
        error instanceof Error ? error.message : String(error)
      );
    }
    if (
      canonicalizeJson(recordContentOf(change)) !==
      canonicalizeJson(recordContentOf(request.change))
    ) {
      throw new InvalidSignedRecordException(
        'mismatch',
        'the record states another change than the request'
      );
    }
    if (record.event.author !== request.wallet.toLowerCase()) {
      throw new InvalidSignedRecordException(
        'author',
        'the record is not signed for the signed-in wallet'
      );
    }
    const identityKey = await identityOfRouteKey(
      request.routeKey,
      this.deps.directory
    );
    const owner = record.owner;
    const ownerIdentity = isPrincipalId(owner)
      ? owner
      : ((await this.deps.directory.identitiesOf([owner])).get(owner) ?? owner);
    if (ownerIdentity !== identityKey) {
      throw new InvalidSignedRecordException(
        'owner',
        "the record's owner is not the identity of this key"
      );
    }
    const consolidationKey =
      (await this.deps.directory.consolidationKeysOf([identityKey])).get(
        identityKey
      ) ?? identityKey;
    return { record, change, identityKey, consolidationKey };
  }

  /**
   * In one transaction: the signed event into the record log, then the
   * change through the record index (newer than the stored head for its
   * key, or stale), worked out with today's rules and written to the
   * identity tables, then its journal entry. Any refusal rolls all of it
   * back.
   */
  private async apply(checked: CheckedRecord): Promise<ChoiceEffects> {
    const atMs = this.deps.now();
    const applied: { effects?: ChoiceEffects } = {};
    const indexer = new RecordIndexer({
      registry: this.registry(checked, atMs, applied),
      heads: this.deps.heads,
      keyring: new SenderKeyring([])
    });
    return this.deps.heads.inTransaction({}, async (ctx) => {
      await this.deps.log.appendEvents(
        JOURNAL_LANE,
        [checked.record.event],
        ctx
      );
      const outcome = await indexer.ingest(checked.record, 'live', ctx);
      if (outcome.kind === 'refused') {
        if (outcome.reason === 'rule') {
          throw new CustomApiCompliantException(
            400,
            outcome.detail,
            outcome.code
          );
        }
        throw new InvalidSignedRecordException(outcome.reason, outcome.detail);
      }
      if (outcome.kind !== 'applied') {
        throw new InvalidSignedRecordException(
          'not-indexed',
          `the record was not indexed (${outcome.kind})`
        );
      }
      if (outcome.changes === 0) {
        throw new CustomApiCompliantException(
          409,
          'A newer change to this choice is already saved.',
          'STALE_SIGNED_RECORD'
        );
      }
      if (!applied.effects) {
        throw new Error('The subscription record was applied without effects');
      }
      return applied.effects;
    });
  }

  /** The four types' handlers, for one record's write. */
  private registry(
    checked: CheckedRecord,
    atMs: number,
    applied: { effects?: ChoiceEffects }
  ): RecordRegistry {
    const registry = new RecordRegistry();
    for (const type of Object.values(SubscriptionRecordType)) {
      registry.register({
        family: 'ps',
        type,
        sealed: false,
        validate: (change) => {
          changeOfRecord(change.type, change.key, change.body);
        },
        apply: async (change, mode, ctx: RequestContext) => {
          if (mode !== 'live' || !ctx.connection) {
            throw new Error(
              'Subscription records apply live only; a rebuild writes back their journal entries'
            );
          }
          const scope: ChoiceScope = {
            identityKey: checked.identityKey,
            consolidationKey: checked.consolidationKey,
            atText: msToDbText(atMs),
            options: { wrappedConnection: ctx.connection },
            rules: true
          };
          const stated = changeOfRecord(change.type, change.key, change.body);
          // The rows the change may write, read FOR UPDATE before it works
          // the change out, so the rebuild can check them.
          const selection = choiceSelection(checked.identityKey, stated);
          const before = await journalBefore(selection, scope.options);
          const made = await makeChoice(scope, stated);
          // What the change wrote, before and after, with the record that
          // made it; rows it left as they were are not journaled.
          await journal(
            {
              kind: 'choice',
              inputs: {
                event_id: checked.record.event.id,
                owner: change.owner,
                type: change.type,
                key: change.key,
                anchor: change.order.anchor,
                claimed_time: change.order.claimedTime
              },
              identities: selection.identities,
              rows: [
                ...selection.rows,
                {
                  table: 'logs',
                  keys: made.logIds.map((id) => ({ id })),
                  inserted: true
                }
              ],
              before,
              atMs
            },
            scope.options
          );
          applied.effects = made.effects;
        }
      });
    }
    return registry;
  }
}

/**
 * The rows a change may write: the identity's balance and mode rows, and
 * its choice rows, the card's for a card or count change, every one for a
 * mode or editions change (its flips and count syncs can touch any
 * upcoming card). The journal keeps only the rows that changed.
 */
function choiceSelection(
  identityKey: string,
  change: SubscriptionChange
): Required<JournalSelection> {
  const choices =
    change.type === 'subs.card' || change.type === 'subs.count'
      ? {
          identity_key: identityKey,
          contract: change.contract,
          token_id: change.tokenId
        }
      : { identity_key: identityKey };
  return {
    identities: [identityKey],
    rows: [{ table: 'choices', keys: [choices] }]
  };
}

/** Today's response for a change, from what the identity side wrote. */
function responseOf(
  routeKey: string,
  change: SubscriptionChange,
  effects: ChoiceEffects
): SubscriptionWriteResponse {
  switch (change.type) {
    case 'subs.mode':
      return { consolidation_key: routeKey, automatic: change.automatic };
    case 'subs.all-editions':
      return {
        consolidation_key: routeKey,
        subscribe_all_editions: change.all
      };
    case 'subs.card': {
      const card = effects.cards.find((c) => c.tokenId === change.tokenId);
      return {
        consolidation_key: routeKey,
        contract: change.contract,
        token_id: change.tokenId,
        subscribed: change.subscribed,
        subscribed_count: card?.subscribedCount ?? 1
      };
    }
    case 'subs.count':
      return {
        consolidation_key: routeKey,
        contract: change.contract,
        token_id: change.tokenId,
        count: change.count
      };
  }
}

export const subscriptionChangeWriter = new SubscriptionChangeWriter();
