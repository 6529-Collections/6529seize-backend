import { Logger } from '@/logging';
import { DbPoolName } from '@/db-query.options';
import { dbSupplier, SqlExecutor } from '@/sql-executor';
import { CrpConnection, WebSocketFactory } from './crp-client';
import { WaveRelayPublishDb } from './wave-relay-publish.db';
import {
  relayRunScope,
  scopeSqlParamValues,
  WAVES_SWITCH_ON_AT_ENV,
  wavesSwitchedOn
} from './wave-relay-scope';
import {
  RelayRunResult,
  WaveRelayPublisher,
  WaveRelayPublisherOptions
} from './wave-relay-publisher';

/**
 * Settings (env or the lambdas secret, as every backend setting):
 * - FEATURE_WAVES_RELAY_PUBLISH=true turns publishing on, from the
 *   switch-on (WAVES_SWITCH_ON_AT, or FEATURE_WAVES_ON_CHAIN=true), read
 *   each run: it can be set ahead. Before the switch-on a run publishes,
 *   reads and passes over nothing, and says once that it waits; from the
 *   switch-on it starts at each relay's cursor, so the device-signed events
 *   written before then go first.
 * - WAVES_RELAY_URLS: the relays' CRP addresses, comma separated
 *   (`wss://...`). Each relay gets every event, from its own cursor.
 * - WAVES_RELAY_NET: the network the relays serve, the chain's id (such as
 *   `6529-chain-1`); a relay on another network is refused.
 * - FEATURE_WAVES_RELAY_PUBLISH_MEMBERS_ONLY=true also publishes members-only
 *   waves (a read group, or under a wave with one). Turn it on only when
 *   every listed relay runs with chain rights (`--api`), so it serves them
 *   to their members alone; a relay without rights serves every wave to
 *   anyone. A wave that stays on 6529.io is never published, members-only
 *   or not (wave-relay-scope.ts): before switch-on every members-only wave
 *   stays; after, this flag matters for members-only waves the chain holds.
 * - SIGNED_RECORDS_WAVE_ID: 6529.io's records wave, which stays on 6529.io
 *   and is never published; `none` (in any case) when there is none.
 *   Unset, or an id that names no wave, nothing is published before the
 *   switch-on, with an error each run: the records wave would go to the
 *   relays.
 * - WAVES_SWITCH_ON_AT or FEATURE_WAVES_ON_CHAIN=true: the switch-on, and
 *   WAVES_SETTLEMENT_NETWORK_ID: the chain's network. After the switch-on,
 *   until the chain index has a full read on it, nothing is published,
 *   with a warning each run (wave-relay-scope.ts).
 *
 * Pacing (DEFAULT_PUBLISH_RUN): a run each minute, 30 seconds of it, the
 * relays one after another with an equal share of the time left; on one
 * connection at least 25 ms between two publishes (40 a second, under a
 * relay's 50) and 4.5 a second for one grant (under its 5); and at most
 * 600 events a relay a run.
 */
export interface WaveRelayPublishConfig {
  readonly relays: string[];
  readonly net: string;
  /** FEATURE_WAVES_RELAY_PUBLISH_MEMBERS_ONLY: members-only waves too. */
  readonly includeMembersOnly: boolean;
}

export class WaveRelayPublishConfigError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'WaveRelayPublishConfigError';
  }
}

/** The settings, or null when publishing is off. */
export function waveRelayPublishConfig(
  env: Record<string, string | undefined> = process.env
): WaveRelayPublishConfig | null {
  if (env.FEATURE_WAVES_RELAY_PUBLISH !== 'true') {
    return null;
  }
  const relays = Array.from(
    new Set(
      (env.WAVES_RELAY_URLS ?? '')
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean)
    )
  );
  if (!relays.length) {
    throw new WaveRelayPublishConfigError(
      'FEATURE_WAVES_RELAY_PUBLISH is on but WAVES_RELAY_URLS names no relay'
    );
  }
  for (const relay of relays) {
    if (!/^wss?:\/\/[^\s]+$/i.test(relay) || relay.length > 255) {
      throw new WaveRelayPublishConfigError(
        `WAVES_RELAY_URLS: "${relay}" is not a ws:// or wss:// address`
      );
    }
  }
  const net = env.WAVES_RELAY_NET?.trim();
  if (!net) {
    throw new WaveRelayPublishConfigError(
      'FEATURE_WAVES_RELAY_PUBLISH is on but WAVES_RELAY_NET is not set'
    );
  }
  return {
    relays,
    net,
    includeMembersOnly: env.FEATURE_WAVES_RELAY_PUBLISH_MEMBERS_ONLY === 'true'
  };
}

/** One run's limits: about half a minute in a loop that runs every minute. */
export const DEFAULT_PUBLISH_RUN: Omit<WaveRelayPublisherOptions, 'relays'> = {
  budgetMs: 30_000,
  batchSize: 500,
  // 600 a minute: 10 a second on average, a fifth of what a relay takes
  // from one connection, so the backlog at the switch-on (every
  // device-signed event since signing began) goes to every relay in step,
  // 36,000 an hour, without crowding the relays while the chain's waves
  // import runs. Live posting is far below it and never waits on it.
  maxPerRelayRun: 600,
  graceMs: 60_000,
  // A write still unfinished after 15 minutes failed to record its drop.
  abandonAfterMs: 15 * 60_000,
  window: 20,
  // A relay takes 50 publishes a second from one connection, and 5 a second
  // (bursts of 60) from one grant; stay under both.
  minIntervalMs: 25,
  grantRate: 4.5,
  grantBurst: 50,
  maxStuckRuns: 10
};

const logger = Logger.get('WAVE_RELAY_PUBLISH');

export const waveRelayPublishDb = new WaveRelayPublishDb(dbSupplier);

/** The switch-on time last logged as waited for, so it is logged once. */
let waitingNoted: string | null = null;

/**
 * Publishes the device-signed drop events written since the last run to
 * every configured relay. Does nothing when publishing is off.
 */
export async function runWaveRelayPublishing({
  env = process.env,
  factory,
  run = DEFAULT_PUBLISH_RUN,
  scopeDb = () => dbSupplier(),
  now = () => Date.now()
}: {
  env?: Record<string, string | undefined>;
  factory?: WebSocketFactory;
  run?: Omit<WaveRelayPublisherOptions, 'relays'>;
  /** Where the chain index's state is read (tests give their own). */
  scopeDb?: () => Pick<SqlExecutor, 'execute'>;
  now?: () => number;
} = {}): Promise<RelayRunResult[] | null> {
  const config = waveRelayPublishConfig(env);
  if (!config) {
    return null;
  }
  // Nothing goes to the relays before the switch-on, however early the flag
  // was set: no cursor moves, nothing is passed over or counted.
  if (!wavesSwitchedOn(env, now())) {
    const at = env[WAVES_SWITCH_ON_AT_ENV]?.trim() || 'unset';
    if (waitingNoted !== at) {
      waitingNoted = at;
      logger.info(
        `[WAVE RELAY PUBLISHING WAITS FOR THE SWITCH-ON] [${WAVES_SWITCH_ON_AT_ENV} ${at}] [NOTHING IS PUBLISHED OR PASSED OVER UNTIL THEN]`
      );
    }
    return [];
  }
  waitingNoted = null;
  // Which waves stay, decided once a run; or nothing published, and why.
  const scope = await relayRunScope(
    scopeDb(),
    { forcePool: DbPoolName.WRITE },
    env,
    now()
  );
  if (!scope.publish) {
    if (scope.level === 'error') logger.error(scope.reason);
    else logger.warn(scope.reason);
    return [];
  }
  const publisher = new WaveRelayPublisher(
    waveRelayPublishDb.source({
      includeMembersOnly: config.includeMembersOnly,
      mode: scope.mode,
      scopeParams: scopeSqlParamValues(scope.recordsWaveId, env)
    }),
    waveRelayPublishDb,
    (relay) => CrpConnection.open(relay, config.net, { factory }),
    (message) => logger.info(message)
  );
  return publisher.publishPending({ ...run, relays: config.relays });
}

/** For a loop that does other work: a failure here is logged, not thrown. */
export async function runWaveRelayPublishingBestEffort(): Promise<void> {
  try {
    await runWaveRelayPublishing();
  } catch (error) {
    logger.error(`[WAVE RELAY PUBLISHING FAILED] ${error}`);
  }
}
