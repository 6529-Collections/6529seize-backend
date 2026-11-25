import type {
  CollectingRule,
  CollectingRuleDefinition
} from '@/collecting/collecting-rules.types';
import type { CollectRuleOperationEntity } from '@/entities/ICollectRule';
import { ApiCompliantException } from '@/exceptions';
import type { RequestContext } from '@/request.context';
import {
  ApplyMode,
  RecordChange,
  RecordRuleError,
  RecordTypeHandler
} from '@/signed-records/record-index';
import { byCodeUnit } from '@/signed-records/record-order';

/**
 * Collect rules as personal records. The person signs only their intent,
 * `collect.rule` (key: the rule id, body {definition, paused}): the first
 * creates the rule, later ones pause or resume it. Reviews, sent
 * transactions and settlements are the server's verified facts, logged in
 * the record log's `collect` lane (collecting-rules.log.ts).
 * `collect.rule-state` and `collect.op` come only from the import at the
 * switch: each rule and operation binding as stored then.
 */
export const CollectRecordType = {
  RULE: 'collect.rule',
  RULE_STATE: 'collect.rule-state',
  OPERATION: 'collect.op'
} as const;

// Rule ids are UUIDs (the rule routes take only those); idempotency keys
// and market operation ids are today's short ids.
const RULE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID = /^[a-zA-Z0-9_-]{1,36}$/;
const HASH = /^[0-9a-f]{64}$/;
const TX_HASH = /^0x[0-9a-f]{64}$/;

export interface CollectRuleChange {
  readonly id: string;
  readonly profileId: string;
  readonly definition: CollectingRuleDefinition;
  readonly paused: boolean;
  readonly eventId: string;
}

/**
 * A `collect.rule` record as the person signed it, opened in a rebuild's
 * first pass: the collect lane's `rule` entry for it must say the same.
 */
export interface SignedCollectRule {
  readonly rule: string;
  readonly profileId: string;
  readonly definition: CollectingRuleDefinition;
  readonly paused: boolean;
}

/** The store and today's live checks, bound in personal-records.wiring.ts. */
export interface CollectRuleDeps {
  /**
   * Applies a person's record in ctx.connection's transaction and logs it.
   * Live, a new rule's terms pass today's checks first (the funding wallet
   * is one of the profile's, the artworks are in the catalog, the plan
   * matches its analysis).
   */
  applyRule(
    change: CollectRuleChange,
    mode: ApplyMode,
    ctx: RequestContext
  ): Promise<void>;
  restoreRule(
    state: {
      readonly rule: CollectingRule;
      readonly idempotencyKey: string;
      readonly requestHash: string;
    },
    ctx: RequestContext
  ): Promise<void>;
  restoreOperation(
    binding: CollectRuleOperationEntity,
    ctx: RequestContext
  ): Promise<void>;
}

class InvalidCollectChange extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, InvalidCollectChange.prototype);
  }
}

function invalid(message: string): never {
  throw new InvalidCollectChange(message);
}

function exactFields(
  body: Record<string, unknown>,
  keys: readonly string[],
  what: string
): void {
  const present = Object.keys(body).sort(byCodeUnit);
  const wanted = [...keys].sort(byCodeUnit);
  if (
    present.length !== wanted.length ||
    present.some((key, i) => key !== wanted[i])
  ) {
    invalid(`${what} has the fields ${wanted.join(', ')}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ruleRecordOf(change: RecordChange): {
  definition: CollectingRuleDefinition;
  paused: boolean;
} {
  if (change.eventId === null) {
    invalid('A collect rule comes from a signed record');
  }
  if (!RULE_ID.test(change.key)) invalid('A collect rule key is a rule id');
  if (change.body === null) invalid('A collect rule record has a body');
  exactFields(change.body, ['definition', 'paused'], 'A collect rule record');
  const { definition, paused } = change.body;
  if (!isObject(definition) || typeof paused !== 'boolean') {
    invalid('A collect rule record is {definition, paused}');
  }
  return {
    definition: definition as unknown as CollectingRuleDefinition,
    paused
  };
}

function importOnly(change: RecordChange, what: string): void {
  if (change.eventId !== null) invalid(`${what} comes only from the import`);
  if (change.body === null) invalid(`${what} has a body`);
}

function ruleStateOf(change: RecordChange): {
  rule: CollectingRule;
  idempotencyKey: string;
  requestHash: string;
} {
  importOnly(change, 'An imported collect rule');
  const body = change.body!;
  exactFields(
    body,
    ['rule', 'idempotency_key', 'request_hash'],
    'An imported collect rule'
  );
  const { rule, idempotency_key, request_hash } = body;
  if (
    !isObject(rule) ||
    rule.id !== change.key ||
    !RULE_ID.test(change.key) ||
    typeof idempotency_key !== 'string' ||
    !SHORT_ID.test(idempotency_key) ||
    typeof request_hash !== 'string' ||
    !HASH.test(request_hash)
  ) {
    invalid(
      'An imported collect rule is {rule, idempotency_key, request_hash}'
    );
  }
  return {
    rule: rule as unknown as CollectingRule,
    idempotencyKey: idempotency_key,
    requestHash: request_hash
  };
}

function operationOf(change: RecordChange): CollectRuleOperationEntity {
  importOnly(change, 'An imported collect operation');
  const body = change.body!;
  exactFields(
    body,
    [
      'rule_id',
      'review_hash',
      'settlement_hash',
      'transaction_hash',
      'transaction_nonce',
      'created_at'
    ],
    'An imported collect operation'
  );
  const nullableHash = (value: unknown, pattern: RegExp) =>
    value === null || (typeof value === 'string' && pattern.test(value));
  if (
    !SHORT_ID.test(change.key) ||
    typeof body.rule_id !== 'string' ||
    !RULE_ID.test(body.rule_id) ||
    typeof body.review_hash !== 'string' ||
    !HASH.test(body.review_hash) ||
    !nullableHash(body.settlement_hash, HASH) ||
    !nullableHash(body.transaction_hash, TX_HASH) ||
    !(
      body.transaction_nonce === null ||
      (Number.isSafeInteger(body.transaction_nonce) &&
        (body.transaction_nonce as number) >= 0)
    ) ||
    typeof body.created_at !== 'number' ||
    !Number.isSafeInteger(body.created_at)
  ) {
    invalid('An imported collect operation is malformed');
  }
  return {
    operation_id: change.key,
    rule_id: body.rule_id,
    review_hash: body.review_hash,
    settlement_hash: body.settlement_hash as string | null,
    transaction_hash: body.transaction_hash as string | null,
    transaction_nonce: body.transaction_nonce as number | null,
    created_at: body.created_at
  };
}

/** Today's 4xx answers about a rule refuse a live record by rule. */
function asRuleError(error: unknown): unknown {
  if (!(error instanceof ApiCompliantException)) return error;
  const status = error.getStatusCode();
  if (status >= 500) return error;
  const code =
    status === 409
      ? 'COLLECT_RULE_CONFLICT'
      : status === 403
        ? 'COLLECT_RULE_FORBIDDEN'
        : 'COLLECT_RULE_INVALID';
  return new RecordRuleError(error.message, code);
}

export function collectRuleHandlers(deps: {
  readonly collect?: CollectRuleDeps;
  readonly profileIdOf: (
    change: RecordChange,
    mode: ApplyMode
  ) => Promise<string | null>;
  // A rebuild applies rules in the collect lane's order instead, and keeps
  // each record as signed here, by event id, to check the lane against.
  readonly deferred?: Map<string, SignedCollectRule>;
}): RecordTypeHandler[] {
  const collect = (): CollectRuleDeps => {
    if (!deps.collect) throw new Error('Collect rules are not wired');
    return deps.collect;
  };
  return [
    {
      family: 'pv',
      type: CollectRecordType.RULE,
      sealed: true,
      validate: (change) => {
        ruleRecordOf(change);
      },
      apply: async (change, mode, ctx) => {
        const { definition, paused } = ruleRecordOf(change);
        const profileId = await deps.profileIdOf(change, mode);
        if (!profileId) return;
        if (deps.deferred) {
          deps.deferred.set(change.eventId!, {
            rule: change.key,
            profileId,
            definition,
            paused
          });
          return;
        }
        try {
          await collect().applyRule(
            {
              id: change.key,
              profileId,
              definition,
              paused,
              eventId: change.eventId!
            },
            mode,
            ctx
          );
        } catch (error) {
          throw mode === 'live' ? asRuleError(error) : error;
        }
      }
    },
    {
      family: 'pv',
      type: CollectRecordType.RULE_STATE,
      sealed: true,
      validate: (change) => {
        ruleStateOf(change);
      },
      apply: (change, _mode, ctx) =>
        collect().restoreRule(ruleStateOf(change), ctx)
    },
    {
      family: 'pv',
      type: CollectRecordType.OPERATION,
      sealed: true,
      validate: (change) => {
        operationOf(change);
      },
      apply: (change, _mode, ctx) =>
        collect().restoreOperation(operationOf(change), ctx)
    }
  ];
}
