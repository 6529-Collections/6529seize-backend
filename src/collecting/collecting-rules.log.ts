import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { byCodeUnit } from '@/signed-records/record-order';
import type {
  CollectingRuleDefinition,
  CollectingRuleReview,
  CollectingRuleSettlement
} from './collecting-rules.types';

/**
 * The record log lane of Collect rules, on the private chain: one entry per
 * change, in the transaction that makes it, so the log's order is the
 * order the changes were made. A person's `collect.rule` record (create,
 * pause, resume) is logged as signed and again here as applied; reviews,
 * sent transactions, settlements and releases are facts the server checks
 * against the market service and Ethereum, and only the server logs them.
 * `at` is always the server's time of the change. Hashes are logged as
 * computed live: a rebuild must not recompute them from JSON whose key
 * order the log's canonical form changed.
 */
export const COLLECT_LOG_LANE = 'collect';

export type CollectLogBody =
  | {
      readonly kind: 'rule';
      readonly rule: string;
      // The person's record this applies; a rebuild checks it was logged.
      readonly event_id: string;
      readonly profile_id: string;
      readonly definition: CollectingRuleDefinition;
      readonly paused: boolean;
      readonly at: number;
    }
  | {
      readonly kind: 'review';
      readonly rule: string;
      readonly review: CollectingRuleReview;
      readonly review_hash: string;
      readonly at: number;
    }
  | {
      readonly kind: 'sent';
      readonly rule: string;
      readonly operation_id: string;
      readonly transaction_hash: string;
      // The transaction's nonce, as Ethereum showed it when it was checked;
      // null while it is unchecked (not seen yet). A later check logs the
      // hash again, with its nonce.
      readonly nonce: number | null;
      readonly at: number;
    }
  | {
      readonly kind: 'settle';
      readonly rule: string;
      readonly settlement: CollectingRuleSettlement;
      readonly settlement_hash: string;
      readonly at: number;
    }
  | {
      readonly kind: 'released';
      readonly rule: string;
      readonly operation_id: string;
      // Set when a sent transaction can never be mined: the funding
      // wallet mined past its nonce with no receipt for it.
      readonly transaction_hash: string | null;
      readonly at: number;
    };

export function collectLogEntry(body: CollectLogBody): RecordLogEntry {
  return {
    t: 'entry',
    lane: COLLECT_LOG_LANE,
    chain: 'private',
    body: body as unknown as Record<string, unknown>
  };
}

const KINDS: Readonly<Record<CollectLogBody['kind'], readonly string[]>> = {
  rule: ['event_id', 'profile_id', 'definition', 'paused'],
  review: ['review', 'review_hash'],
  sent: ['operation_id', 'transaction_hash', 'nonce'],
  settle: ['settlement', 'settlement_hash'],
  released: ['operation_id', 'transaction_hash']
};

/** A logged body's shape; the store's own checks run when it is applied. */
export function parseCollectLogBody(
  body: Record<string, unknown>
): CollectLogBody {
  const kind = body.kind as CollectLogBody['kind'];
  const fields = Object.prototype.hasOwnProperty.call(KINDS, String(kind))
    ? KINDS[kind]
    : null;
  const keys = Object.keys(body).sort(byCodeUnit);
  const wanted = fields
    ? ['at', 'kind', 'rule', ...fields].sort(byCodeUnit)
    : null;
  if (
    !wanted ||
    keys.length !== wanted.length ||
    keys.some((key, i) => key !== wanted[i]) ||
    typeof body.rule !== 'string' ||
    typeof body.at !== 'number' ||
    !Number.isSafeInteger(body.at)
  ) {
    throw new Error('Malformed Collect rules log entry');
  }
  return body as unknown as CollectLogBody;
}
