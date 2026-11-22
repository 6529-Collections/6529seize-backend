import { randomUUID } from 'node:crypto';
import { collectingHash } from '@/collecting/collecting-analysis';
import {
  assertCollectingRuleContinuation,
  createCollectingRule,
  currentRule,
  normalizeRuleDefinition,
  pauseCollectingRule,
  reserveCollectingRuleReview,
  ruleConflict,
  settleCollectingRule
} from '@/collecting/collecting-rules';
import {
  CollectingRule,
  CollectingRuleDefinition,
  CollectingRuleReview,
  CollectingRuleSettlement
} from '@/collecting/collecting-rules.types';
import {
  CollectRuleEntity,
  CollectRuleOperationEntity
} from '@/entities/ICollectRule';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import { marketChain } from '@/marketplace/market-chain';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { ConnectionWrapper, dbSupplier, SqlExecutor } from '@/sql-executor';
import {
  SentEvidence,
  SentTransaction,
  sentTransactionProblem,
  settlementProblem,
  unminedProblem,
  usedNonceOutcome
} from './collecting-rules.chain-check';
import {
  collectRulesJournal,
  CollectRulesJournal
} from './collecting-rules.journal';
import type { CollectLogBody } from './collecting-rules.log';

export const COLLECT_RULES_TABLE = 'collect_rules';
export const COLLECT_RULE_OPERATIONS_TABLE = 'collect_rule_operations';

interface RuleRow extends Omit<CollectRuleEntity, 'payload_json'> {
  payload_json: string | CollectingRule;
}

function readRule(row: RuleRow): CollectingRule {
  return typeof row.payload_json === 'string'
    ? JSON.parse(row.payload_json)
    : row.payload_json;
}

async function sentTransactionOnChain(
  hash: string
): Promise<SentTransaction | null> {
  const transaction = await marketChain().rpc.getTransaction(hash);
  return transaction
    ? {
        from: transaction.from,
        to: transaction.to,
        value: transaction.value,
        nonce: transaction.nonce
      }
    : null;
}

/** A sent purchase to release as never mined, with what Ethereum shows. */
export interface UnminedRelease {
  readonly transactionHash: string;
  readonly evidence: SentEvidence;
}

/**
 * Why a settlement isn't of the purchase's sent transaction, nor of the one
 * that used its nonce instead (sped up or replaced), or null.
 */
function settledTransactionProblem(
  binding: CollectRuleOperationEntity | null,
  settlement: CollectingRuleSettlement,
  evidence: SentEvidence | undefined
): string | null {
  const sent = binding?.transaction_hash ?? null;
  if (!binding || !sent || sent === settlement.transaction_hash) return null;
  const nonce = nonceOf(binding);
  return nonce !== null && evidence?.transaction?.nonce === nonce
    ? null
    : 'the settlement is not of the sent transaction, nor of one at its nonce';
}

/** A binding's stored nonce; null for a hash sent before nonces were kept. */
function nonceOf(binding: CollectRuleOperationEntity): number | null {
  return binding.transaction_nonce === null ||
    binding.transaction_nonce === undefined
    ? null
    : Number(binding.transaction_nonce);
}

/** A change of the rule: the next revision, at `now` (as collecting-rules.ts). */
function nextRevision(rule: CollectingRule, now: number): CollectingRule {
  return { ...rule, revision: rule.revision + 1, updated_at: now };
}

/** Callers enforce direct-wallet authentication and current profile membership.
 * Review/settlement inputs must come from the verified market service, never a client body.
 * No method signs, sends transactions, polls autonomously, or sends notifications.
 * In primary mode every change is also logged (collecting-rules.log.ts).
 */
export class CollectingRulesService {
  constructor(
    private readonly getDb: () => SqlExecutor = dbSupplier,
    private readonly now: () => number = Date.now,
    private readonly journal: CollectRulesJournal = collectRulesJournal,
    // A sent hash's transaction on Ethereum (recordSent checks it).
    private readonly transactions: (
      hash: string
    ) => Promise<SentTransaction | null> = sentTransactionOnChain
  ) {}

  async create(
    definition: CollectingRuleDefinition,
    key: string
  ): Promise<CollectingRule> {
    if (!/^[a-zA-Z0-9_-]{1,36}$/.test(key))
      throw new BadRequestException('Invalid rule request key');
    const now = this.now();
    const normalized = normalizeRuleDefinition(definition, now);
    const rule = createCollectingRule(randomUUID(), normalized, now);
    const hash = collectingHash(normalized);
    return this.getDb().executeNativeQueriesInTransaction(
      async (connection) => {
        await this.getDb().execute(
          `INSERT INTO ${COLLECT_RULES_TABLE} (id,profile_id,idempotency_key,request_hash,payload_json,state,revision,created_at,updated_at)
         VALUES (:id,:profileId,:key,:hash,:payload,:state,:revision,:now,:now) ON DUPLICATE KEY UPDATE id=id`,
          {
            id: rule.id,
            profileId: definition.profile_id,
            key,
            hash,
            payload: JSON.stringify(rule),
            state: rule.state,
            revision: rule.revision,
            now
          },
          { wrappedConnection: connection }
        );
        const saved = await this.getDb().oneOrNull<RuleRow>(
          `SELECT * FROM ${COLLECT_RULES_TABLE} WHERE profile_id=:profileId AND idempotency_key=:key FOR UPDATE`,
          { profileId: definition.profile_id, key },
          { wrappedConnection: connection }
        );
        if (!saved || saved.request_hash !== hash)
          ruleConflict('Request key belongs to different rule terms.');
        return currentRule(readRule(saved), now);
      }
    );
  }

  async get(id: string, profileId: string): Promise<CollectingRule> {
    const row = await this.getDb().oneOrNull<RuleRow>(
      `SELECT * FROM ${COLLECT_RULES_TABLE} WHERE id=:id AND profile_id=:profileId`,
      { id, profileId }
    );
    if (!row) throw new NotFoundException('Saved rule not found.');
    return currentRule(readRule(row), this.now());
  }

  async list(profileId: string, limit = 50): Promise<CollectingRule[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException(
        'Rule list limit must be between 1 and 100'
      );
    const rows = await this.getDb().execute<RuleRow>(
      `SELECT * FROM ${COLLECT_RULES_TABLE} WHERE profile_id=:profileId ORDER BY updated_at DESC,id DESC LIMIT :limit`,
      { profileId, limit }
    );
    return rows.map((row) => currentRule(readRule(row), this.now()));
  }

  /**
   * Locks the rule, applies `update` and writes the result unless `update`
   * returned the rule unchanged. A null profile id (a rebuild's replay)
   * finds the rule by id alone; `at` replaces the clock in a replay.
   */
  private async mutate(
    id: string,
    profileId: string | null,
    update: (
      rule: CollectingRule,
      connection: ConnectionWrapper<unknown>
    ) => Promise<CollectingRule>,
    existingConnection?: ConnectionWrapper<unknown>,
    at?: number
  ): Promise<CollectingRule> {
    const execute = async (connection: ConnectionWrapper<unknown>) => {
      const row = await this.getDb().oneOrNull<RuleRow>(
        `SELECT * FROM ${COLLECT_RULES_TABLE} WHERE id=:id${profileId === null ? '' : ' AND profile_id=:profileId'} FOR UPDATE`,
        { id, profileId },
        { wrappedConnection: connection }
      );
      if (!row) throw new NotFoundException('Saved rule not found.');
      const before = readRule(row);
      const updated = await update(before, connection);
      if (updated !== before) await this.writeRule(updated, connection);
      return currentRule(updated, at ?? this.now());
    };
    return existingConnection
      ? execute(existingConnection)
      : this.getDb().executeNativeQueriesInTransaction(execute);
  }

  private async writeRule(
    rule: CollectingRule,
    connection: ConnectionWrapper<unknown>
  ): Promise<void> {
    await this.getDb().execute(
      `UPDATE ${COLLECT_RULES_TABLE} SET payload_json=:payload,state=:state,revision=:revision,updated_at=:updatedAt WHERE id=:id`,
      {
        id: rule.id,
        payload: JSON.stringify(rule),
        state: rule.state,
        revision: rule.revision,
        updatedAt: rule.updated_at
      },
      { wrappedConnection: connection }
    );
  }

  private async log(
    body: CollectLogBody,
    connection: ConnectionWrapper<unknown>
  ): Promise<void> {
    if (this.journal.enabled()) await this.journal.append(body, connection);
  }

  async setPaused(
    id: string,
    profileId: string,
    expectedRevision: number,
    paused: boolean
  ): Promise<CollectingRule> {
    return this.mutate(id, profileId, async (rule) =>
      pauseCollectingRule(rule, paused, expectedRevision, this.now())
    );
  }

  async reserveReview(
    id: string,
    profileId: string,
    review: CollectingRuleReview,
    existingConnection?: ConnectionWrapper<unknown>
  ): Promise<CollectingRule> {
    return this.mutate(
      id,
      profileId,
      async (rule, connection) => {
        const hash = collectingHash(review);
        await this.getDb().execute(
          `INSERT INTO ${COLLECT_RULE_OPERATIONS_TABLE} (operation_id,rule_id,review_hash,settlement_hash,created_at)
         VALUES (:operationId,:id,:hash,NULL,:now) ON DUPLICATE KEY UPDATE operation_id=operation_id`,
          { operationId: review.operation_id, id, hash, now: this.now() },
          { wrappedConnection: connection }
        );
        const binding =
          await this.getDb().oneOrNull<CollectRuleOperationEntity>(
            `SELECT * FROM ${COLLECT_RULE_OPERATIONS_TABLE} WHERE operation_id=:operationId FOR UPDATE`,
            { operationId: review.operation_id },
            { wrappedConnection: connection }
          );
        if (
          !binding ||
          binding.rule_id !== id ||
          binding.review_hash !== hash ||
          binding.settlement_hash
        )
          ruleConflict(
            'Operation is already bound to different or completed rule terms.'
          );
        if (rule.pending_review?.operation_id === review.operation_id)
          return rule;
        const now = this.now();
        const reserved = reserveCollectingRuleReview(rule, review, now);
        await this.log(
          { kind: 'review', rule: id, review, review_hash: hash, at: now },
          connection
        );
        return reserved;
      },
      existingConnection
    );
  }

  /** Pass the market transition's transaction connection to retain the rule lock
   * until that transition commits. Hash submission and reconciliation do not use this guard.
   */
  async assertOperationContinuation(
    operationId: string,
    review: Omit<CollectingRuleReview, 'operation_id'>,
    connection?: ConnectionWrapper<unknown>
  ): Promise<void> {
    const binding = await this.getDb().oneOrNull<CollectRuleOperationEntity>(
      `SELECT * FROM ${COLLECT_RULE_OPERATIONS_TABLE} WHERE operation_id=:operationId`,
      { operationId },
      { wrappedConnection: connection }
    );
    if (!binding)
      ruleConflict(
        'Operation does not have a reserved collecting rule review.'
      );
    const row = await this.getDb().oneOrNull<RuleRow>(
      `SELECT * FROM ${COLLECT_RULES_TABLE} WHERE id=:id ${connection ? 'FOR UPDATE' : ''}`,
      { id: binding.rule_id },
      { wrappedConnection: connection }
    );
    if (!row) ruleConflict('The saved rule for this operation is unavailable.');
    assertCollectingRuleContinuation(
      readRule(row),
      { ...review, operation_id: operationId },
      this.now()
    );
  }

  /** Only chain-proven terminal outcomes may release a pending operation.
   * A quote expiry, user pause, failed request, or missing transaction hash is not proof.
   */
  async settle(
    id: string,
    profileId: string,
    settlement: CollectingRuleSettlement,
    // What Ethereum shows for its hash. Where the settlement is logged
    // (primary), it is checked as a rebuild will check it, so nothing is
    // logged that a rebuild would refuse.
    evidence?: SentEvidence
  ): Promise<CollectingRule> {
    return this.mutate(id, profileId, async (rule, connection) => {
      const pending = rule.pending_review;
      if (
        this.journal.enabled() &&
        pending?.operation_id === settlement.operation_id
      ) {
        const problem = evidence
          ? (settlementProblem(settlement, pending, evidence) ??
            settledTransactionProblem(
              await this.findOperation(settlement.operation_id, connection),
              settlement,
              evidence
            ))
          : 'nothing from Ethereum to check it against';
        if (problem)
          ruleConflict(
            `The purchase can't be settled from Ethereum: ${problem}.`
          );
      }
      const now = this.now();
      const hash = collectingHash(settlement);
      const updated = await this.settleLocked(
        rule,
        settlement,
        hash,
        now,
        connection
      );
      if (updated === rule) return rule;
      await this.log(
        {
          kind: 'settle',
          rule: id,
          settlement,
          settlement_hash: hash,
          at: now
        },
        connection
      );
      return updated;
    });
  }

  /**
   * A settlement of the rule's operation, live and in a replay (with the
   * hash as logged). A repeat with the same evidence returns the rule
   * unchanged.
   */
  private async settleLocked(
    rule: CollectingRule,
    settlement: CollectingRuleSettlement,
    hash: string,
    at: number,
    connection: ConnectionWrapper<unknown>
  ): Promise<CollectingRule> {
    const binding = await this.findOperation(
      settlement.operation_id,
      connection
    );
    if (!binding || binding.rule_id !== rule.id)
      ruleConflict('Operation is not bound to this rule.');
    if (binding.settlement_hash) {
      if (binding.settlement_hash !== hash)
        ruleConflict(
          'Operation was already reconciled with different evidence.'
        );
      return rule;
    }
    const updated = settleCollectingRule(rule, settlement, at);
    await this.getDb().execute(
      `UPDATE ${COLLECT_RULE_OPERATIONS_TABLE} SET settlement_hash=:hash WHERE operation_id=:operationId`,
      { hash, operationId: settlement.operation_id },
      { wrappedConnection: connection }
    );
    return updated;
  }

  /** The binding of a market operation to a rule, if it has one. */
  async findOperation(
    operationId: string,
    connection?: ConnectionWrapper<unknown>
  ): Promise<CollectRuleOperationEntity | null> {
    return this.getDb().oneOrNull<CollectRuleOperationEntity>(
      `SELECT * FROM ${COLLECT_RULE_OPERATIONS_TABLE} WHERE operation_id=:operationId${connection ? ' FOR UPDATE' : ''}`,
      { operationId },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  /**
   * Keeps the transaction hash of a rule's operation, so a reconcile can
   * settle it from Ethereum even after the market journal is gone. The
   * hash is the one the person submitted to the market, which has kept it.
   * Where it is logged (primary, or while frozen for the switch: the
   * submit route isn't), Ethereum is asked for its transaction:
   * - seen and the rule's pending purchase (from the funding wallet, to
   *   the market contract, paying the reviewed cost): kept with its nonce
   *   and logged with it;
   * - seen and not that purchase: refused;
   * - not seen yet (just broadcast, or sent privately): kept and logged
   *   unchecked, with no nonce. Calling this again (reconcile does) checks
   *   it, keeps its nonce and logs it again. Settlement and the rebuild
   *   check the transaction anyway; an unchecked hash is never released
   *   as unmined.
   * Outside those it is kept as the market accepted it, as before. An
   * operation that is no rule's: nothing to keep.
   */
  async recordSent(
    operationId: string,
    transactionHash: string,
    existingConnection?: ConnectionWrapper<unknown>
  ): Promise<void> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
      throw new BadRequestException('Invalid transaction hash');
    }
    const hash = transactionHash.toLowerCase();
    const known = await this.findOperation(operationId);
    const checked = (binding: CollectRuleOperationEntity | null) =>
      binding?.transaction_hash === hash && nonceOf(binding) !== null;
    if (!known || checked(known)) return;
    const logged = this.journal.enabled() || (await this.journal.frozen());
    if (!logged && known.transaction_hash === hash) return;
    const transaction = logged ? await this.transactions(hash) : null;
    const execute = async (connection: ConnectionWrapper<unknown>) => {
      const binding = await this.findOperation(operationId, connection);
      if (!binding || checked(binding)) return;
      // Its nonce, from the transaction just checked, settles whether it
      // can still be mined; a hash kept unchecked has none.
      let nonce: number | null = null;
      if (logged && transaction) {
        const rule = await this.lockRule(binding.rule_id, connection);
        const pending = rule.pending_review;
        if (pending?.operation_id === operationId) {
          const problem = sentTransactionProblem(pending, transaction);
          if (problem)
            throw new ForbiddenException(
              `The transaction is not this rule's purchase: ${problem}.`
            );
          nonce = transaction.nonce;
        }
      }
      if (binding.transaction_hash === hash && nonce === null) return;
      await this.getDb().execute(
        `UPDATE ${COLLECT_RULE_OPERATIONS_TABLE} SET transaction_hash=:hash,transaction_nonce=:nonce WHERE operation_id=:operationId`,
        { hash, nonce, operationId },
        { wrappedConnection: connection }
      );
      if (logged) {
        await this.journal.append(
          {
            kind: 'sent',
            rule: binding.rule_id,
            operation_id: operationId,
            transaction_hash: hash,
            nonce,
            at: this.now()
          },
          connection
        );
      }
    };
    if (existingConnection) await execute(existingConnection);
    else await this.getDb().executeNativeQueriesInTransaction(execute);
  }

  private async lockRule(
    id: string,
    connection: ConnectionWrapper<unknown>
  ): Promise<CollectingRule> {
    const row = await this.getDb().oneOrNull<RuleRow>(
      `SELECT * FROM ${COLLECT_RULES_TABLE} WHERE id=:id FOR UPDATE`,
      { id },
      { wrappedConnection: connection }
    );
    if (!row) ruleConflict('The saved rule for this operation is unavailable.');
    return readRule(row);
  }

  /**
   * Frees a pending review whose purchase can no longer happen, once its
   * quote has expired: one never sent, or one sent (`unmined`) that
   * Ethereum shows can never be mined: no receipt for its hash, and the
   * funding wallet has mined past its stored nonce. A hash kept without a
   * nonce is never released this way. The caller checks that the market
   * operation is gone (a rebuild keeps no journal of orders in flight).
   * The review still counts; the person prepares again.
   */
  async release(
    id: string,
    profileId: string,
    operationId: string,
    unmined: UnminedRelease | null = null
  ): Promise<CollectingRule> {
    return this.mutate(id, profileId, async (rule, connection) => {
      if (rule.pending_review?.operation_id !== operationId) return rule;
      const now = this.now();
      const released = await this.releaseLocked(
        rule,
        operationId,
        unmined,
        now,
        connection
      );
      await this.log(
        {
          kind: 'released',
          rule: id,
          operation_id: operationId,
          transaction_hash: unmined?.transactionHash ?? null,
          at: now
        },
        connection
      );
      return released;
    });
  }

  /** A release's checks and result, live and in a replay. */
  private async releaseLocked(
    rule: CollectingRule,
    operationId: string,
    unmined: UnminedRelease | null,
    at: number,
    connection: ConnectionWrapper<unknown>
  ): Promise<CollectingRule> {
    const pending = rule.pending_review;
    if (pending?.operation_id !== operationId)
      ruleConflict('No pending purchase to release.');
    const binding = await this.findOperation(operationId, connection);
    if (!binding || binding.rule_id !== rule.id)
      ruleConflict('Operation is not bound to this rule.');
    const sent = binding.transaction_hash ?? null;
    if (sent !== (unmined?.transactionHash ?? null)) {
      ruleConflict(
        sent
          ? 'The pending purchase was sent; reconcile it instead.'
          : 'No transaction was sent for this purchase.'
      );
    }
    if (pending.valid_until > at) {
      ruleConflict('The pending purchase can still be sent.');
    }
    if (unmined) {
      const { receipt, minedNonce, nonceTransaction } = unmined.evidence;
      if (!minedNonce || !nonceTransaction)
        ruleConflict('No Ethereum source to check the sent transaction.');
      const nonce = nonceOf(binding);
      const problem = unminedProblem(
        receipt,
        nonce,
        await minedNonce(pending.funding_wallet)
      );
      if (problem)
        ruleConflict(`The sent purchase can't be released: ${problem}.`);
      // Sped up or replaced, the purchase may have been mined at the same
      // nonce under another hash: then it is settled, never released.
      const used = await nonceTransaction(pending.funding_wallet, nonce!);
      if (!used)
        ruleConflict(
          `The sent purchase can't be released: the transaction at nonce ${nonce} isn't found.`
        );
      const outcome = usedNonceOutcome(pending, used);
      if (outcome.kind === 'settle')
        ruleConflict(
          `The transaction at nonce ${nonce} is the purchase, mined as ${used.hash}: settle it instead.`
        );
      if (outcome.kind === 'problem')
        ruleConflict(
          `The transaction at nonce ${nonce} delivered the reviewed artwork, but ${outcome.problem}.`
        );
    }
    return nextRevision({ ...rule, pending_review: null }, at);
  }

  /**
   * A person's `collect.rule` record, in its transaction: the first one
   * creates the rule (active), later ones pause or resume it, and the
   * terms can't change. Validity and times are the server's (`at`, now by
   * default); the record's claimed time only orders it. Logged as applied
   * when the journal is on.
   */
  async applyRuleRecord(
    change: {
      readonly id: string;
      readonly profileId: string;
      readonly definition: CollectingRuleDefinition;
      readonly paused: boolean;
      readonly eventId: string;
    },
    connection: ConnectionWrapper<unknown>,
    opts: {
      readonly log: boolean;
      // A replay's logged server time; live, now.
      readonly at?: number;
      // Live: today's checks of a new rule's terms, run only on create.
      readonly beforeCreate?: () => Promise<void>;
    } = { log: true }
  ): Promise<void> {
    const at = opts.at ?? this.now();
    const row = await this.getDb().oneOrNull<RuleRow>(
      `SELECT * FROM ${COLLECT_RULES_TABLE} WHERE id=:id FOR UPDATE`,
      { id: change.id },
      { wrappedConnection: connection }
    );
    if (row) {
      const rule = readRule(row);
      if (row.profile_id !== change.profileId) {
        ruleConflict('Saved rule not found.');
      }
      if (
        canonicalizeJson(change.definition as never) !==
        canonicalizeJson(rule.definition as never)
      ) {
        ruleConflict("A saved rule's terms can't change.");
      }
      const userPaused =
        rule.state === 'PAUSED' && rule.pause_reason === 'USER_PAUSED';
      const unchanged = change.paused
        ? userPaused
        : currentRule(rule, at).state === 'ACTIVE';
      if (unchanged) return;
      await this.writeRule(
        pauseCollectingRule(rule, change.paused, rule.revision, at),
        connection
      );
    } else {
      if (change.paused) ruleConflict('A new rule starts active.');
      if (opts.beforeCreate) await opts.beforeCreate();
      const normalized = normalizeRuleDefinition(change.definition, at);
      if (normalized.profile_id !== change.profileId) {
        ruleConflict('Create a rule for your own profile.');
      }
      const rule = createCollectingRule(change.id, normalized, at);
      await this.getDb().execute(
        `INSERT INTO ${COLLECT_RULES_TABLE} (id,profile_id,idempotency_key,request_hash,payload_json,state,revision,created_at,updated_at)
         VALUES (:id,:profileId,:id,:hash,:payload,:state,:revision,:at,:at)`,
        {
          id: change.id,
          profileId: change.profileId,
          hash: collectingHash(normalized),
          payload: JSON.stringify(rule),
          state: rule.state,
          revision: rule.revision,
          at
        },
        { wrappedConnection: connection }
      );
    }
    if (opts.log) {
      await this.log(
        {
          kind: 'rule',
          rule: change.id,
          event_id: change.eventId,
          profile_id: change.profileId,
          definition: change.definition,
          paused: change.paused,
          at
        },
        connection
      );
    }
  }

  /** A rule as the import at the switch carried it, stored as it was. */
  async restoreRule(
    state: {
      readonly rule: CollectingRule;
      readonly idempotencyKey: string;
      readonly requestHash: string;
    },
    connection: ConnectionWrapper<unknown>
  ): Promise<void> {
    const { rule } = state;
    await this.getDb().execute(
      `INSERT INTO ${COLLECT_RULES_TABLE} (id,profile_id,idempotency_key,request_hash,payload_json,state,revision,created_at,updated_at)
       VALUES (:id,:profileId,:key,:hash,:payload,:state,:revision,:createdAt,:updatedAt)
       ON DUPLICATE KEY UPDATE payload_json=:payload,state=:state,revision=:revision,updated_at=:updatedAt`,
      {
        id: rule.id,
        profileId: rule.definition.profile_id,
        key: state.idempotencyKey,
        hash: state.requestHash,
        payload: JSON.stringify(rule),
        state: rule.state,
        revision: rule.revision,
        createdAt: rule.created_at,
        updatedAt: rule.updated_at
      },
      { wrappedConnection: connection }
    );
  }

  /** An operation binding as the import carried it. */
  async restoreOperation(
    binding: CollectRuleOperationEntity,
    connection: ConnectionWrapper<unknown>
  ): Promise<void> {
    await this.getDb().execute(
      `INSERT INTO ${COLLECT_RULE_OPERATIONS_TABLE} (operation_id,rule_id,review_hash,settlement_hash,transaction_hash,transaction_nonce,created_at)
       VALUES (:operation_id,:rule_id,:review_hash,:settlement_hash,:transaction_hash,:transaction_nonce,:created_at)
       ON DUPLICATE KEY UPDATE settlement_hash=:settlement_hash,transaction_hash=:transaction_hash,transaction_nonce=:transaction_nonce`,
      {
        operation_id: binding.operation_id,
        rule_id: binding.rule_id,
        review_hash: binding.review_hash,
        settlement_hash: binding.settlement_hash,
        transaction_hash: binding.transaction_hash,
        transaction_nonce: nonceOf(binding),
        created_at: binding.created_at
      },
      { wrappedConnection: connection }
    );
  }

  /**
   * A rebuild's replay of one logged change, at its logged time and with
   * its logged hashes, through the same checks as live: what live would
   * have refused is refused. A settlement, and a release of a sent
   * transaction, are checked against `evidence`, what Ethereum shows for
   * their hash.
   */
  async replay(
    body: CollectLogBody,
    connection: ConnectionWrapper<unknown>,
    evidence?: SentEvidence
  ): Promise<void> {
    const at = body.at;
    switch (body.kind) {
      case 'rule':
        await this.applyRuleRecord(
          {
            id: body.rule,
            profileId: body.profile_id,
            definition: body.definition,
            paused: body.paused,
            eventId: body.event_id
          },
          connection,
          { log: false, at }
        );
        return;
      case 'review':
        await this.getDb().execute(
          `INSERT INTO ${COLLECT_RULE_OPERATIONS_TABLE} (operation_id,rule_id,review_hash,settlement_hash,created_at)
           VALUES (:operationId,:id,:hash,NULL,:at)`,
          {
            operationId: body.review.operation_id,
            id: body.rule,
            hash: body.review_hash,
            at
          },
          { wrappedConnection: connection }
        );
        await this.mutate(
          body.rule,
          null,
          async (rule) => reserveCollectingRuleReview(rule, body.review, at),
          connection,
          at
        );
        return;
      case 'sent': {
        // A hash changes no rule: the settle or release that follows is
        // what is checked on Ethereum.
        const binding = await this.findOperation(body.operation_id, connection);
        if (!binding || binding.rule_id !== body.rule)
          ruleConflict('Operation is not bound to this rule.');
        await this.getDb().execute(
          `UPDATE ${COLLECT_RULE_OPERATIONS_TABLE} SET transaction_hash=:hash,transaction_nonce=:nonce WHERE operation_id=:operationId`,
          {
            hash: body.transaction_hash,
            nonce: body.nonce,
            operationId: body.operation_id
          },
          { wrappedConnection: connection }
        );
        return;
      }
      case 'settle':
        await this.mutate(
          body.rule,
          null,
          async (rule, tx) => {
            const binding = await this.findOperation(
              body.settlement.operation_id,
              tx
            );
            if (binding?.settlement_hash)
              ruleConflict('Operation was already reconciled.');
            const replaced = settledTransactionProblem(
              binding,
              body.settlement,
              evidence
            );
            if (replaced) ruleConflict(replaced);
            const pending = rule.pending_review;
            if (pending?.operation_id !== body.settlement.operation_id)
              ruleConflict('Settlement does not match the pending operation.');
            const problem = settlementProblem(
              body.settlement,
              pending,
              evidence ?? { transaction: null, receipt: null }
            );
            if (problem) ruleConflict(problem);
            return this.settleLocked(
              rule,
              body.settlement,
              body.settlement_hash,
              at,
              tx
            );
          },
          connection,
          at
        );
        return;
      case 'released':
        await this.mutate(
          body.rule,
          null,
          async (rule, tx) => {
            if (body.transaction_hash !== null && !evidence)
              ruleConflict(
                'No Ethereum source to check the released transaction.'
              );
            return this.releaseLocked(
              rule,
              body.operation_id,
              body.transaction_hash !== null && evidence
                ? { transactionHash: body.transaction_hash, evidence }
                : null,
              at,
              tx
            );
          },
          connection,
          at
        );
        return;
    }
  }
}

export const collectingRulesService = new CollectingRulesService();
