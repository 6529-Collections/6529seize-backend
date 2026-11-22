import { DEVICE_SIGNATURE_MAX_CLOCK_SKEW_MS } from '@/api/device-signing/device-signed-writes.service';
import {
  updateSubscribeAllEditions,
  updateSubscription,
  updateSubscriptionCount,
  updateSubscriptionMode
} from '@/api/subscriptions/api.subscriptions.db';
import {
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_KEY_MAP_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_ID_TOP_UP_TABLE
} from '@/constants';
import {
  ApiCompliantException,
  CustomApiCompliantException,
  ForbiddenException
} from '@/exceptions';
import { Logger } from '@/logging';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { DbQueryOptions } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
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
  /**
   * Whether the wallet is one of the key's wallets (the route's own check).
   * When it is not, the key is a principal id, and only the IDENTITY path
   * takes it, for a wallet of that identity.
   */
  readonly walletInKey: boolean;
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
  /** The identity the route's key and the record's owner both name. */
  readonly identityKey: string;
}

/**
 * Where an applied change went: the key of the rows it wrote (the identity,
 * or a bare wallet whose rows the fold has not moved yet), its
 * consolidation key, and its effects.
 */
interface AppliedChange {
  readonly targetKey: string;
  readonly consolidationKey: string;
  readonly effects: ChoiceEffects;
}

/** Today's rules refused the change on the identity side (a RecordRuleError). */
class RuleRefusalException extends CustomApiCompliantException {
  constructor(message: string, code: string | undefined) {
    super(400, message, code);
  }
}

const STALE_SIGNED_RECORD = 'STALE_SIGNED_RECORD';
const ANCHOR_UNAVAILABLE = 'ANCHOR_UNAVAILABLE';
const BINDING_UNAVAILABLE = 'BINDING_UNAVAILABLE';

/**
 * The binding source for verification, with its failures (the chain
 * gateway down or slow) answered as a 503 the device can retry, as a
 * missing anchor is, rather than as a server error.
 */
function bindingsOrUnavailable(
  source: PrincipalBindingSource
): PrincipalBindingSource {
  return {
    async principalAt(wallet: string, height: number) {
      try {
        return await source.principalAt(wallet, height);
      } catch (error) {
        logger.warn('[WALLET BINDING NOT READ]', error);
        throw new CustomApiCompliantException(
          503,
          'The chain gateway did not answer, so the wallet binding could not be checked',
          BINDING_UNAVAILABLE
        );
      }
    }
  };
}

/**
 * Why a shadow companion did not apply, as a code, and whether the go-live
 * gate counts it: the record's own failings (it did not verify or state
 * the request, it was stale, the anchor or the author's binding could not
 * be had) are REFUSED and not counted, so one person's bad header can't
 * hold the switch back; a rule the identity side applied differently is a
 * DIFF; an error FAILED.
 */
function failureOf(error: unknown): {
  readonly verdict: 'REFUSED' | 'DIFF' | 'FAILED';
  readonly cause: string;
} {
  if (error instanceof InvalidSignedRecordException) {
    return { verdict: 'REFUSED', cause: `invalid-record:${error.reason}` };
  }
  if (error instanceof RuleRefusalException) {
    return { verdict: 'DIFF', cause: `rule:${error.code ?? 'unknown'}` };
  }
  if (error instanceof ApiCompliantException) {
    const code = error.code ?? String(error.getStatusCode());
    return {
      verdict:
        code === STALE_SIGNED_RECORD ||
        code === ANCHOR_UNAVAILABLE ||
        code === BINDING_UNAVAILABLE
          ? 'REFUSED'
          : 'DIFF',
      cause: `refused:${code}`
    };
  }
  return { verdict: 'FAILED', cause: 'error' };
}

export class SubscriptionChangeWriter {
  constructor(private readonly deps: SubscriptionWriteDeps = defaultDeps()) {}

  async write(
    request: SubscriptionWriteRequest
  ): Promise<SubscriptionWriteResponse> {
    const path = await this.pathNow();
    if (path === 'PAUSED') {
      throw new CustomApiCompliantException(
        503,
        'Subscription changes are paused for a few minutes. Try again shortly.'
      );
    }
    await this.assertKeyAccess(request, path);
    switch (path) {
      case 'LEGACY':
        return this.deps.legacy(request.routeKey, request.change);
      case 'SHADOW':
        return this.shadow(request);
      case 'IDENTITY':
        return this.identity(request);
    }
  }

  /**
   * A key the wallet is not in (a principal id) is taken only after the
   * switch, and only from a wallet the identity mirror has in that identity.
   * The legacy tables have no principal keys, so before the switch it is 403
   * as it always was.
   */
  private async assertKeyAccess(
    request: SubscriptionWriteRequest,
    path: SubscriptionWritePath
  ): Promise<void> {
    if (request.walletInKey) {
      return;
    }
    if (path === 'IDENTITY') {
      const wallet = request.wallet.toLowerCase();
      const identity =
        (await this.deps.directory.identitiesOf([wallet])).get(wallet) ??
        wallet;
      if (
        identity ===
        (await identityOfRouteKey(request.routeKey, this.deps.directory))
      ) {
        return;
      }
    }
    throw new ForbiddenException(
      'User can only change subscription mode for their own consolidation'
    );
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
    const applied = await this.apply(checked);
    try {
      await this.deps.legacy(applied.consolidationKey, checked.change);
    } catch (error) {
      // The legacy tables (the rollback copy) now lag the identity tables
      // for this person: alarm. The legacy write marks coverage after its
      // own transaction; it did not get there, so mark it here.
      logger.errorWithCode(
        'SUBSCRIPTIONS_LEGACY_DUAL_WRITE_FAILED',
        `[LEGACY DUAL WRITE FAILED] [${checked.change.type}] [event ${checked.record.event.id}]`,
        error
      );
      try {
        await markSubscriptionCoverageDirty(
          [applied.consolidationKey],
          COVERAGE_REASON[checked.change.type]
        );
      } catch (markError) {
        logger.error('[COVERAGE MARKER FAILED]', markError);
      }
    }
    return responseOf(request.routeKey, checked.change, applied.effects);
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
      const { effects } = await this.apply(checked);
      report = await compareShadowChange({
        routeKey: request.routeKey,
        change: checked.change,
        effects,
        legacyLogMark: mark,
        eventId
      });
    } catch (error) {
      const failure = failureOf(error);
      if (failure.verdict === 'FAILED') {
        logger.error(
          `[SHADOW RECORD FAILED] [${request.change.type}] [event ${eventId ?? '-'}]`,
          error
        );
      }
      report = failedShadowReport(request.change, failure, eventId);
    }
    if (report.verdict !== 'MATCH') {
      logger.warn(
        `[SHADOW RECORD ${report.verdict}] [${report.notes.join('] [')}] ${report.diffs.map((diff) => diff.key).join(', ')}`
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
      bindings: bindingsOrUnavailable(this.deps.bindings),
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
    // A bare wallet that has bound to a principal since the record's anchor
    // is that principal's now; its change still counts (see targetKeyOf).
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
    return { record, change, identityKey };
  }

  /**
   * The key of the rows a change writes, read in its transaction: the
   * identity, except for a bare-wallet owner whose own rows are still in
   * the identity tables (it bound since, and the top-up loop's fold has not
   * moved them yet). Those rows take the change, and the fold brings it
   * along; writing the identity's rows instead would leave them behind.
   */
  private async targetKeyOf(
    checked: CheckedRecord,
    options: DbQueryOptions
  ): Promise<string> {
    const owner = checked.record.owner;
    if (isPrincipalId(owner) || owner === checked.identityKey) {
      return checked.identityKey;
    }
    for (const table of [
      SUBSCRIPTIONS_ID_BALANCES_TABLE,
      SUBSCRIPTIONS_ID_MODE_TABLE,
      SUBSCRIPTIONS_ID_NFTS_TABLE
    ]) {
      const rows = await sqlExecutor.execute<{ identity_key: string }>(
        `SELECT identity_key FROM ${table} WHERE identity_key = :owner LIMIT 1 FOR UPDATE`,
        { owner },
        options
      );
      if (rows.length > 0) {
        return owner;
      }
    }
    return checked.identityKey;
  }

  /**
   * A bare-wallet owner whose change goes to its identity's rows must be
   * linked to that identity in the journal, or nothing there would tie the
   * wallet to the rows: the opening names only the wallets it cut, and a
   * fold is journaled only for a wallet with rows of its own. Unless the
   * opening's key map already has the wallet in the identity, an empty
   * fold goes first, in the same transaction: no balance, mode or choice
   * rows to merge, but any history the wallet has (final, redeemed, log and
   * top-up rows, say a log line from before the cut) moves to the identity
   * here, as the fold writer moves it, and the fold's rekey moves it the
   * same way in a rebuild. Folds already posted can't be seen from here, so
   * after the fold writer's own fold of the wallet this repeats the link;
   * a rebuild applies either as a no-op.
   */
  private async linkWalletToIdentity(
    wallet: string,
    identityKey: string,
    atMs: number,
    options: DbQueryOptions
  ): Promise<void> {
    const linked = await sqlExecutor.execute<{ identity_key: string }>(
      `SELECT identity_key FROM ${SUBSCRIPTIONS_ID_KEY_MAP_TABLE}
        WHERE identity_key = :identityKey
          AND FIND_IN_SET(:wallet, REPLACE(LOWER(consolidation_key), '-', ',')) > 0
        LIMIT 1`,
      { identityKey, wallet },
      options
    );
    if (linked.length > 0) {
      return;
    }
    for (const table of [
      SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
      SUBSCRIPTIONS_ID_REDEEMED_TABLE,
      SUBSCRIPTIONS_ID_LOGS_TABLE,
      SUBSCRIPTIONS_ID_TOP_UP_TABLE
    ]) {
      // Final rows keep their priority time (updated_at) when re-keyed.
      const keepTime =
        table === SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE
          ? ', updated_at = updated_at'
          : '';
      await sqlExecutor.execute(
        `UPDATE ${table} SET identity_key = :identityKey${keepTime} WHERE identity_key = :wallet`,
        { identityKey, wallet },
        options
      );
    }
    await journal(
      {
        kind: 'fold',
        inputs: {
          wallet,
          identity_key: identityKey,
          at_text: msToDbText(atMs)
        },
        rekeys: [{ from: wallet, to: identityKey }],
        atMs
      },
      options
    );
  }

  /**
   * In one transaction: the signed event into the record log, then the
   * change through the record index (newer than the stored head for its
   * key, or stale), worked out with today's rules and written to the
   * identity tables, then its journal entry. Any refusal rolls all of it
   * back.
   */
  private async apply(checked: CheckedRecord): Promise<AppliedChange> {
    const atMs = this.deps.now();
    const applied: { change?: AppliedChange } = {};
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
          throw new RuleRefusalException(outcome.detail, outcome.code);
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
          STALE_SIGNED_RECORD
        );
      }
      if (!applied.change) {
        throw new Error('The subscription record was applied without effects');
      }
      return applied.change;
    });
  }

  /** The four types' handlers, for one record's write. */
  private registry(
    checked: CheckedRecord,
    atMs: number,
    applied: { change?: AppliedChange }
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
          const options = { wrappedConnection: ctx.connection };
          const targetKey = await this.targetKeyOf(checked, options);
          const owner = checked.record.owner;
          if (!isPrincipalId(owner) && targetKey !== owner) {
            await this.linkWalletToIdentity(owner, targetKey, atMs, options);
          }
          const consolidationKey =
            (
              await this.deps.directory.consolidationKeysOf(
                [targetKey],
                options
              )
            ).get(targetKey) ?? targetKey;
          const scope: ChoiceScope = {
            identityKey: targetKey,
            consolidationKey,
            atText: msToDbText(atMs),
            options,
            rules: true
          };
          const stated = changeOfRecord(change.type, change.key, change.body);
          // The rows the change may write, read FOR UPDATE before it works
          // the change out, so the rebuild can check them.
          const selection = choiceSelection(targetKey, stated);
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
                claimed_time: change.order.claimedTime,
                // The key of the rows it wrote: the owner's identity, or the
                // owner wallet's own key until the fold moves its rows.
                identity_key: targetKey
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
          applied.change = {
            targetKey,
            consolidationKey,
            effects: made.effects
          };
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
