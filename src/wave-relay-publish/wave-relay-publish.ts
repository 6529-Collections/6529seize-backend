import { Logger } from '@/logging';
import { dbSupplier } from '@/sql-executor';
import { CrpConnection, WebSocketFactory } from './crp-client';
import { WaveRelayPublishDb } from './wave-relay-publish.db';
import {
  RelayRunResult,
  WaveRelayPublisher,
  WaveRelayPublisherOptions
} from './wave-relay-publisher';

/**
 * Settings (env or the lambdas secret, as every backend setting):
 * - FEATURE_WAVES_RELAY_PUBLISH=true turns publishing on.
 * - WAVES_RELAY_URLS: the relays' CRP addresses, comma separated
 *   (`wss://...`). Each relay gets every event, from its own cursor.
 * - WAVES_RELAY_NET: the network the relays serve, the chain's id (such as
 *   `6529-chain-1`); a relay on another network is refused.
 */
export interface WaveRelayPublishConfig {
  readonly relays: string[];
  readonly net: string;
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
  return { relays, net };
}

/** One run's limits: about half a minute in a loop that runs every minute. */
export const DEFAULT_PUBLISH_RUN: Omit<WaveRelayPublisherOptions, 'relays'> = {
  budgetMs: 30_000,
  batchSize: 500,
  graceMs: 60_000,
  window: 20,
  // A relay takes 50 publishes a second from one connection; stay under.
  minIntervalMs: 25
};

const logger = Logger.get('WAVE_RELAY_PUBLISH');

export const waveRelayPublishDb = new WaveRelayPublishDb(dbSupplier);

/**
 * Publishes the device-signed drop events written since the last run to
 * every configured relay. Does nothing when publishing is off.
 */
export async function runWaveRelayPublishing({
  env = process.env,
  factory,
  run = DEFAULT_PUBLISH_RUN
}: {
  env?: Record<string, string | undefined>;
  factory?: WebSocketFactory;
  run?: Omit<WaveRelayPublisherOptions, 'relays'>;
} = {}): Promise<RelayRunResult[] | null> {
  const config = waveRelayPublishConfig(env);
  if (!config) {
    return null;
  }
  const publisher = new WaveRelayPublisher(
    waveRelayPublishDb,
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
