import { Logger } from '@/logging';
import { RebuildContext } from '@/rebuild/manifest.types';
import {
  buildRelayWorld,
  RelayWorldEvent
} from '@/rebuild/world/waves/relay-world';
import { runDropIndex } from '@/wave-drop-index/drop-index';
import { CrpConnection } from '@/wave-relay-publish/crp-client';

const logger = Logger.get('WAVES_REBUILD_DROP_INDEX');

/** The relay network the run's relays speak (the dm area uses the same). */
export const REBUILD_RELAY_NET = '6529-rebuild-check';

/** Switch-on in the run, fixed rather than the code's default. */
export const REBUILD_LIVE_FROM = '2026-11-26T00:00:00Z';

/** Runs of the drop index before the step gives up on the relays. */
const MAX_RUNS = 20;

/**
 * The drop index's settings for the run's relays: the drop index reads every wave the
 * relays carry into wave_relay_events. Applying relay-only events to
 * 6529.io's drop tables (FEATURE_WAVES_DROP_INDEX_APPLY) is the drops
 * step's, not this one's.
 */
export function dropIndexEnv(relays: string): Record<string, string> {
  return {
    FEATURE_WAVES_DROP_INDEX: 'true',
    WAVES_RELAY_URLS: relays,
    WAVES_RELAY_NET: REBUILD_RELAY_NET,
    WAVES_DROP_INDEX_BUDGET_MS: '20000',
    // Switch-on: the world's events are claimed before it, so they are
    // history (IMPORT), as the switch's first run reads them.
    WAVES_DROP_INDEX_LIVE_FROM: REBUILD_LIVE_FROM
  };
}

function relaysOf(ctx: RebuildContext): string {
  const relays = ctx.sources.relays;
  if (!relays) {
    throw new Error(`${ctx.stepId} reads the relays: the run has none`);
  }
  return relays;
}

/**
 * The drop index from its cursors (empty after the drop) until a run
 * stores nothing new: the live loop's reads, back to back.
 */
export async function indexRelays(
  relays: string,
  run: typeof runDropIndex = runDropIndex
): Promise<number> {
  let stored = 0;
  for (let i = 1; i <= MAX_RUNS; i++) {
    const report = await run({ env: dropIndexEnv(relays) });
    const reports = report?.relays ?? [];
    const failed = reports.find((r) => r.error !== null);
    if (failed) {
      throw new Error(
        `The drop index failed on ${failed.relay}: ${failed.error}`
      );
    }
    const now = reports.reduce((sum, r) => sum + r.stored, 0);
    const left = reports.reduce((sum, r) => sum + r.left, 0);
    stored += now;
    logger.info(`[DROP INDEX RUN ${i}] stored ${now}, left ${left}`);
    if (now === 0 && left === 0) return stored;
  }
  throw new Error(`The drop index still had events after ${MAX_RUNS} runs`);
}

/** Publishes the world's events to a relay, as a client posts them. */
export async function publishRelayWorld(
  relays: string,
  events: readonly RelayWorldEvent[] = buildRelayWorld()
): Promise<void> {
  const connection = await CrpConnection.open(relays, REBUILD_RELAY_NET);
  try {
    for (const { event, grant } of events) {
      const ack = await connection.publish(event, grant);
      if (ack.status === 'rejected') {
        throw new Error(`The relay refused ${ack.eventId}: ${ack.reason}`);
      }
    }
  } finally {
    connection.close();
  }
}

/** Seed: drops posted to the relays only, then the index reads them. */
export async function seedWavesDropIndex(ctx: RebuildContext): Promise<void> {
  const relays = relaysOf(ctx);
  await publishRelayWorld(relays);
  const stored = await indexRelays(relays);
  logger.info(`[DROP INDEX SEEDED] ${stored} events`);
}

/** Rebuilder: the index read again from the relays into empty tables. */
export async function rebuildWavesDropIndex(
  ctx: RebuildContext
): Promise<void> {
  const stored = await indexRelays(relaysOf(ctx));
  logger.info(`[DROP INDEX REBUILT] ${stored} events`);
}
