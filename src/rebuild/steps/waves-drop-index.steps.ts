import { Logger } from '@/logging';
import { RebuildContext } from '@/rebuild/manifest.types';
import {
  buildRelayWorld,
  RelayWorldEvent
} from '@/rebuild/world/waves/relay-world';
import {
  testGrantProof,
  TEST_DEVICE_SEED
} from '@/tests/fixtures/relay-events.fixture';
import {
  DEFAULT_DROP_INDEX_RUN,
  dropIndexConfig,
  readerAuthAnswer
} from '@/wave-drop-index/drop-index';
import { dropIndexDb } from '@/wave-drop-index/drop-index.db';
import {
  DropIndexStore,
  DropIndexSubscriber,
  RelayIngestReport
} from '@/wave-drop-index/drop-index.subscriber';
import {
  CrpConnection,
  WebSocketFactory
} from '@/wave-relay-publish/crp-client';
import {
  firstSeenFactory,
  firstSeenStore,
  RelayFirstSeen
} from './waves-relay-first-seen';

const logger = Logger.get('WAVES_REBUILD_DROP_INDEX');

/** The relay network the run's relays speak (the dm area uses the same). */
export const REBUILD_RELAY_NET = '6529-rebuild-check';

/**
 * Switch-on in the run: the drop index's own setting, read by its own
 * parser, so the run and the live loop agree and a move of the date needs
 * no change here. WAVES_DROP_INDEX_LIVE_FROM in the run's environment when
 * given, else the drop index's default (DEFAULT_LIVE_FROM). The seed and
 * the rebuild run in one environment, so both read the same value.
 */
export function rebuildLiveFrom(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  // Only the switch-on is read; the rest satisfies the parser.
  const config = dropIndexConfig({
    FEATURE_WAVES_DROP_INDEX: 'true',
    WAVES_RELAY_URLS: 'ws://127.0.0.1:1',
    WAVES_RELAY_NET: REBUILD_RELAY_NET,
    WAVES_DROP_INDEX_LIVE_FROM: env.WAVES_DROP_INDEX_LIVE_FROM ?? ''
  });
  return new Date(config!.liveFrom).toISOString();
}

/** Runs of the drop index before the step gives up on the relays. */
const MAX_RUNS = 20;

/**
 * The drop index's settings for the run's relays: the drop index reads every wave the
 * relays carry into wave_relay_events, open waves and, as the site reader,
 * members-only ones. Applying relay-only events to
 * 6529.io's drop tables (FEATURE_WAVES_DROP_INDEX_APPLY) is the drops
 * step's, not this one's.
 */
export function dropIndexEnv(
  relays: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  return {
    FEATURE_WAVES_DROP_INDEX: 'true',
    WAVES_RELAY_URLS: relays,
    WAVES_RELAY_NET: REBUILD_RELAY_NET,
    WAVES_DROP_INDEX_BUDGET_MS: '20000',
    // Switch-on: the world's events are claimed before it, so they are
    // history (IMPORT), as the switch's first run reads them.
    WAVES_DROP_INDEX_LIVE_FROM: rebuildLiveFrom(env),
    // 6529.io reads members-only waves as the relays' site reader: here the
    // shared test device key under its grant, which the waves manifest
    // declares a site reader of the run's relays.
    WAVES_DROP_INDEX_READER: JSON.stringify({
      device_seed: TEST_DEVICE_SEED,
      grant: testGrantProof()
    })
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
 * One read of the relays, as the live loop's drop index reads them
 * (runDropIndex with applying off), with one difference: each stored
 * event's `received_at` is when the relays first held it (their receipts,
 * or a recording's first sight; see waves-relay-first-seen.ts), not the
 * run's clock, so a rebuild months later applies it as live would have.
 */
export async function readRelaysOnce(
  env: Record<string, string>,
  deps: {
    readonly store?: DropIndexStore;
    readonly factory?: WebSocketFactory;
    readonly markSiteWritten?: () => Promise<unknown>;
  } = {}
): Promise<RelayIngestReport[]> {
  const config = dropIndexConfig(env);
  if (!config) throw new Error('The drop index is off in its settings');
  const firstSeen = new RelayFirstSeen();
  const subscriber = new DropIndexSubscriber(
    firstSeenStore(deps.store ?? dropIndexDb, firstSeen),
    (relay) =>
      CrpConnection.open(relay, config.net, {
        factory: firstSeenFactory(firstSeen, deps.factory)
      }),
    // No in-process listeners in a rebuild step.
    () => [],
    (message) => logger.info(message),
    config.reader ? readerAuthAnswer(config.reader) : null
  );
  const reports = await subscriber.run({
    ...DEFAULT_DROP_INDEX_RUN,
    relays: config.relays,
    budgetMs: config.budgetMs,
    liveFrom: config.liveFrom
  });
  // As the live loop does: rows learn the drops 6529.io wrote.
  await (deps.markSiteWritten ?? (() => dropIndexDb.markSiteWritten()))();
  return reports;
}

/**
 * The drop index from its cursors (empty after the drop) until a run
 * stores nothing new: the live loop's reads, back to back.
 */
export async function indexRelays(
  relays: string,
  read: (env: Record<string, string>) => Promise<RelayIngestReport[]> = (env) =>
    readRelaysOnce(env)
): Promise<number> {
  let stored = 0;
  for (let i = 1; i <= MAX_RUNS; i++) {
    const reports = await read(dropIndexEnv(relays));
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
