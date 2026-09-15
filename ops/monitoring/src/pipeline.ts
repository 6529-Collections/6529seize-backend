import { Alert, hash, parseAlert, renderAlert } from './contract.js';
import { DeliveryError } from './webhook.js';
import { completeDispatch, traceDispatch } from './dispatch-diagnostics.js';
import type {
  DeliveryResult,
  DeliveryTarget,
  DigestPlan,
  EditDigestPlan,
  PostDigestPlan
} from './digest-plan.js';

export type Work =
  | { kind: 'alert'; alert: Alert }
  | { kind: 'digest'; groupKey: string; eventId: string }
  | {
      kind: 'heartbeat';
      eventId: string;
      lane: 'normal' | 'critical';
      emittedAt: number;
    };
export interface Group {
  count: number;
  firstEventId: string;
  alert: Alert;
  key: string;
}
export interface Store {
  reserve(
    id: string,
    owner: string,
    now: number
  ): Promise<'acquired' | 'done' | 'busy'>;
  complete(
    id: string,
    owner: string,
    outcome: string,
    delivery?: DeliveryResult
  ): Promise<void>;
  release(id: string, owner: string): Promise<void>;
  group(key: string, id: string, alert: Alert): Promise<Group>;
  readGroup(key: string): Promise<Group | null>;
  prepareDigest(id: string, owner: string, group: Group): Promise<DigestPlan>;
  fallbackDigest(
    id: string,
    owner: string,
    plan: EditDigestPlan
  ): Promise<PostDigestPlan>;
  heartbeat(lane: string, now: number): Promise<void>;
}
export interface Transport {
  schedule(work: Work, delay: number): Promise<void>;
  deliver(payload: object, destinationKey?: string): Promise<DeliveryResult>;
  edit(target: DeliveryTarget, payload: object): Promise<DeliveryResult | null>;
  archive(work: Work, reason: string): Promise<void>;
}
export function workId(work: Work): string {
  return work.kind === 'alert' ? work.alert.eventId : work.eventId;
}
export async function processWork(
  work: Work,
  owner: string,
  store: Store,
  transport: Transport,
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  const id = hash(workId(work));
  const lease = await traceDispatch('RESERVE', () =>
    store.reserve(id, owner, now)
  );
  if (lease === 'done') {
    completeDispatch('ALREADY_COMPLETE');
    return;
  }
  if (lease === 'busy') throw new DeliveryError(true, 30, true);
  try {
    const outcome = await execute(work, id, owner, store, transport, now);
    await traceDispatch('COMPLETE', () =>
      store.complete(
        id,
        owner,
        typeof outcome === 'string' ? outcome : outcome.messageId,
        typeof outcome === 'string' ? undefined : outcome
      )
    );
    completeDispatch(terminalOutcome(outcome));
  } catch (error) {
    if (error instanceof DeliveryError && !error.retryable) {
      await traceDispatch('ARCHIVE', async () => {
        await transport.archive(work, 'WEBHOOK_PERMANENT');
        await traceDispatch('COMPLETE', () =>
          store.complete(id, owner, 'archived')
        );
      });
      completeDispatch('ARCHIVED');
      return;
    }
    await traceDispatch('RELEASE', () => store.release(id, owner));
    throw error;
  }
}
function terminalOutcome(outcome: string | DeliveryResult) {
  if (typeof outcome !== 'string')
    return outcome.operation === 'EDIT' ? 'EDITED' : 'DELIVERED';
  switch (outcome) {
    case 'grouped':
      return 'GROUPED';
    case 'heartbeat':
      return 'HEARTBEAT';
    case 'no-repeat':
      return 'NO_REPEAT';
    default:
      return 'DELIVERED';
  }
}
async function execute(
  work: Work,
  id: string,
  owner: string,
  store: Store,
  transport: Transport,
  now: number
): Promise<string | DeliveryResult> {
  if (work.kind === 'heartbeat') {
    // Receipt proves a fresh canary traversed the queue, not merely that a scheduler ran.
    return traceDispatch('HEARTBEAT', async () => {
      if (Math.abs(now - work.emittedAt) > 180) throw new DeliveryError(false);
      await store.heartbeat(work.lane, now);
      return 'heartbeat';
    });
  }
  if (work.kind === 'digest') {
    const group = await traceDispatch('DIGEST_READ', async () => {
      const value = await store.readGroup(work.groupKey);
      if (!value) throw new Error('MISSING_GROUP');
      return value;
    });
    return executeDigest(group, id, owner, store, transport);
  }
  const alert = parseAlert(work.alert);
  if (alert.severity !== 'error') return transport.deliver(renderAlert(alert));
  const bucket = Math.floor(now / 300);
  const key = `group:${alert.environment}:${alert.fingerprint}:${bucket}`;
  const group = await traceDispatch('GROUP', () => store.group(key, id, alert));
  if (group.firstEventId !== id) return 'grouped';
  // Scheduling is retried before acknowledgement; deterministic digest receipts absorb duplicates.
  await traceDispatch('SCHEDULE', () =>
    transport.schedule(
      {
        kind: 'digest',
        groupKey: group.key,
        eventId: `digest:${hash(group.key)}`
      },
      Math.max(
        0,
        Math.min(900, (Number(group.key.split(':').at(-1)) + 1) * 300 + 5 - now)
      )
    )
  );
  return transport.deliver(renderAlert(alert));
}
async function executeDigest(
  group: Group,
  id: string,
  owner: string,
  store: Store,
  transport: Transport
): Promise<string | DeliveryResult> {
  if (!Number.isSafeInteger(group.count) || group.count < 1)
    throw new Error('INVALID_GROUP_COUNT');
  if (group.count === 1) return 'no-repeat';
  let plan = await traceDispatch('DIGEST_PLAN', () =>
    store.prepareDigest(id, owner, group)
  );
  if (plan.mode === 'EDIT') {
    const edited = await transport.edit(
      plan.target,
      renderAlert(group.alert, plan.count)
    );
    if (edited) return edited;
    const missing = plan;
    plan = await traceDispatch('DIGEST_FALLBACK', () =>
      store.fallbackDigest(id, owner, missing)
    );
  }
  return transport.deliver(
    renderAlert(group.alert, plan.count),
    plan.reason === 'TARGET_MISSING' ? plan.destinationKey : undefined
  );
}
export function parseWork(value: unknown): Work {
  if (!value || typeof value !== 'object') throw new Error('INVALID_WORK');
  const v = value as Record<string, unknown>;
  if (v.kind === 'alert') return { kind: 'alert', alert: parseAlert(v.alert) };
  if (
    v.kind === 'digest' &&
    typeof v.groupKey === 'string' &&
    /^group:[a-zA-Z0-9:./-]{1,240}$/.test(v.groupKey) &&
    typeof v.eventId === 'string' &&
    /^digest:[a-f0-9]{64}$/.test(v.eventId)
  ) {
    return { kind: 'digest', groupKey: v.groupKey, eventId: v.eventId };
  }
  if (
    v.kind === 'heartbeat' &&
    typeof v.eventId === 'string' &&
    /^heartbeat:[a-z]+:[a-f0-9-]{36}$/.test(v.eventId) &&
    (v.lane === 'normal' || v.lane === 'critical') &&
    typeof v.emittedAt === 'number'
  ) {
    return {
      kind: 'heartbeat',
      eventId: v.eventId,
      lane: v.lane,
      emittedAt: v.emittedAt
    };
  }
  throw new Error('INVALID_WORK');
}
