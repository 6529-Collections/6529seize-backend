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
import { BadRequestException, NotFoundException } from '@/exceptions';
import { ConnectionWrapper, dbSupplier, SqlExecutor } from '@/sql-executor';

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

/** Callers enforce direct-wallet authentication and current profile membership.
 * Review/settlement inputs must come from the verified market service, never a client body.
 * No method signs, sends transactions, polls autonomously, or sends notifications.
 */
export class CollectingRulesService {
  constructor(
    private readonly getDb: () => SqlExecutor = dbSupplier,
    private readonly now: () => number = Date.now
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

  private async mutate(
    id: string,
    profileId: string,
    update: (
      rule: CollectingRule,
      connection: ConnectionWrapper<unknown>
    ) => Promise<CollectingRule>,
    existingConnection?: ConnectionWrapper<unknown>
  ): Promise<CollectingRule> {
    const execute = async (connection: ConnectionWrapper<unknown>) => {
      const row = await this.getDb().oneOrNull<RuleRow>(
        `SELECT * FROM ${COLLECT_RULES_TABLE} WHERE id=:id AND profile_id=:profileId FOR UPDATE`,
        { id, profileId },
        { wrappedConnection: connection }
      );
      if (!row) throw new NotFoundException('Saved rule not found.');
      const updated = await update(readRule(row), connection);
      await this.getDb().execute(
        `UPDATE ${COLLECT_RULES_TABLE} SET payload_json=:payload,state=:state,revision=:revision,updated_at=:updatedAt WHERE id=:id`,
        {
          id,
          payload: JSON.stringify(updated),
          state: updated.state,
          revision: updated.revision,
          updatedAt: updated.updated_at
        },
        { wrappedConnection: connection }
      );
      return currentRule(updated, this.now());
    };
    return existingConnection
      ? execute(existingConnection)
      : this.getDb().executeNativeQueriesInTransaction(execute);
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
        return reserveCollectingRuleReview(rule, review, this.now());
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
    settlement: CollectingRuleSettlement
  ): Promise<CollectingRule> {
    return this.mutate(id, profileId, async (rule, connection) => {
      const binding = await this.getDb().oneOrNull<CollectRuleOperationEntity>(
        `SELECT * FROM ${COLLECT_RULE_OPERATIONS_TABLE} WHERE operation_id=:operationId FOR UPDATE`,
        { operationId: settlement.operation_id },
        { wrappedConnection: connection }
      );
      if (!binding || binding.rule_id !== id)
        ruleConflict('Operation is not bound to this rule.');
      const hash = collectingHash(settlement);
      if (binding.settlement_hash) {
        if (binding.settlement_hash !== hash)
          ruleConflict(
            'Operation was already reconciled with different evidence.'
          );
        return rule;
      }
      const updated = settleCollectingRule(rule, settlement, this.now());
      await this.getDb().execute(
        `UPDATE ${COLLECT_RULE_OPERATIONS_TABLE} SET settlement_hash=:hash WHERE operation_id=:operationId`,
        { hash, operationId: settlement.operation_id },
        { wrappedConnection: connection }
      );
      return updated;
    });
  }
}

export const collectingRulesService = new CollectingRulesService();
