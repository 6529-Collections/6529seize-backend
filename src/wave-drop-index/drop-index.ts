import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { ethers } from 'ethers';
import { Logger } from '@/logging';
import {
  CrpAuthAnswer,
  CrpChallenge,
  CrpConnection,
  CrpWelcome,
  WebSocketFactory
} from '@/wave-relay-publish/crp-client';
import { dropIndexDb } from './drop-index.db';
import {
  ApplyReport,
  RelayDropApplier,
  RelayDropWrites
} from './relay-drop-applier';
import {
  DropIndexListener,
  DropIndexRunOptions,
  DropIndexSubscriber,
  RelayIngestReport
} from './drop-index.subscriber';

/**
 * Settings (env or the lambdas secret):
 * - FEATURE_WAVES_DROP_INDEX=true turns the drop index on: each run reads
 *   the relays in WAVES_RELAY_URLS on network WAVES_RELAY_NET (the
 *   settings relay publishing uses) into wave_relay_events.
 * - WAVES_DROP_INDEX_READER (optional): the device key and grant of a
 *   wallet the relays list as a site reader, as JSON
 *   `{"device_seed": "0x<64 hex>", "grant": <the grant proof>}`, so the
 *   index also reads members-only waves. Without it, a relay with chain
 *   rights serves only waves anyone may read.
 * - WAVES_DROP_INDEX_BUDGET_MS (optional, default 25000): one run's time.
 * - FEATURE_WAVES_DROP_INDEX_APPLY=true (from switch-on) also writes the
 *   relay-only events into 6529.io's drop tables, as 6529.io's API writes
 *   a signed drop by its author (relay-drop-applier.ts); 60% of the run
 *   reads the relays, the rest writes.
 */
export interface DropIndexConfig {
  readonly relays: string[];
  readonly net: string;
  readonly reader: DropIndexReader | null;
  readonly budgetMs: number;
  readonly apply: boolean;
}

export interface DropIndexReader {
  readonly deviceSeed: string;
  readonly grant: Record<string, unknown>;
}

export class DropIndexConfigError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'DropIndexConfigError';
  }
}

const DEFAULT_BUDGET_MS = 25_000;

function readerOf(raw: string | undefined): DropIndexReader | null {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DropIndexConfigError('WAVES_DROP_INDEX_READER is not JSON');
  }
  const value = parsed as { device_seed?: unknown; grant?: unknown };
  if (
    typeof value?.device_seed !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(value.device_seed) ||
    !value.grant ||
    typeof value.grant !== 'object'
  ) {
    throw new DropIndexConfigError(
      'WAVES_DROP_INDEX_READER needs device_seed (0x and 64 hex) and grant'
    );
  }
  return {
    deviceSeed: value.device_seed.toLowerCase(),
    grant: value.grant as Record<string, unknown>
  };
}

/** The settings, or null when the drop index is off. */
export function dropIndexConfig(
  env: Record<string, string | undefined> = process.env
): DropIndexConfig | null {
  if (env.FEATURE_WAVES_DROP_INDEX !== 'true') return null;
  const relays = Array.from(
    new Set(
      (env.WAVES_RELAY_URLS ?? '')
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean)
    )
  );
  if (!relays.length) {
    throw new DropIndexConfigError(
      'FEATURE_WAVES_DROP_INDEX is on but WAVES_RELAY_URLS names no relay'
    );
  }
  for (const relay of relays) {
    if (!/^wss?:\/\/[^\s]+$/i.test(relay) || relay.length > 255) {
      throw new DropIndexConfigError(
        `WAVES_RELAY_URLS: "${relay}" is not a ws:// or wss:// address`
      );
    }
  }
  const net = env.WAVES_RELAY_NET?.trim();
  if (!net) {
    throw new DropIndexConfigError(
      'FEATURE_WAVES_DROP_INDEX is on but WAVES_RELAY_NET is not set'
    );
  }
  const budget = Number(env.WAVES_DROP_INDEX_BUDGET_MS?.trim());
  return {
    relays,
    net,
    reader: readerOf(env.WAVES_DROP_INDEX_READER),
    budgetMs:
      Number.isSafeInteger(budget) && budget > 0 ? budget : DEFAULT_BUDGET_MS,
    apply: env.FEATURE_WAVES_DROP_INDEX_APPLY === 'true'
  };
}

const ED25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex'
);

function bytes32(hex: string): Uint8Array {
  return ethers.getBytes(hex);
}

/**
 * The digest an AUTH signs (validator wave-relay auth.rs `auth_digest`):
 * keccak256(keccak256("6529.RelayAuth.v1") || keccak256(net) ||
 * keccak256(relay_id) || nonce || grantId).
 */
export function relayAuthDigest(
  net: string,
  relayId: string,
  nonce: string,
  grantId: string
): string {
  return ethers.keccak256(
    ethers.concat([
      ethers.keccak256(ethers.toUtf8Bytes('6529.RelayAuth.v1')),
      ethers.keccak256(ethers.toUtf8Bytes(net)),
      ethers.keccak256(ethers.toUtf8Bytes(relayId)),
      bytes32(nonce),
      bytes32(grantId)
    ])
  );
}

/** The site reader's AUTH answer to a relay's CHALLENGE. */
export function readerAuthAnswer(
  reader: DropIndexReader
): (challenge: CrpChallenge, welcome: CrpWelcome) => CrpAuthAnswer {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      ED25519_PKCS8_PREFIX,
      Buffer.from(reader.deviceSeed.slice(2), 'hex')
    ]),
    format: 'der',
    type: 'pkcs8'
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32);
  const grantKey = String(reader.grant.device_key ?? '').toLowerCase();
  if (`0x${publicKey.toString('hex')}` !== grantKey) {
    throw new DropIndexConfigError(
      "WAVES_DROP_INDEX_READER: the device seed is not the grant's device key"
    );
  }
  const grantId = String(reader.grant.id ?? '');
  return (challenge, welcome) => {
    const digest = relayAuthDigest(
      welcome.net,
      welcome.relayId,
      challenge.nonce,
      grantId
    );
    const sig = sign(null, Buffer.from(digest.slice(2), 'hex'), privateKey);
    return { grant: reader.grant, sig: `0x${sig.toString('hex')}` };
  };
}

const listeners: DropIndexListener[] = [];

/**
 * Hears every batch the index stores, after its commit, in the index's
 * order (the notify lane's in-process hook). Returns the way to stop.
 */
export function onDropIndexStored(listener: DropIndexListener): () => void {
  listeners.push(listener);
  return () => {
    const at = listeners.indexOf(listener);
    if (at >= 0) listeners.splice(at, 1);
  };
}

const logger = Logger.get('WAVE_DROP_INDEX');

export const DEFAULT_DROP_INDEX_RUN: Omit<
  DropIndexRunOptions,
  'relays' | 'budgetMs'
> = {
  quietMs: 3_000,
  flushMs: 250,
  pageSize: 500
};

export interface DropIndexRunReport {
  readonly relays: RelayIngestReport[];
  readonly applied: ApplyReport | null;
}

/** Events written into 6529.io's tables a run, at most. */
const APPLY_BATCH = 200;

/**
 * Reads the relays into the drop index, then (with apply on) writes the
 * relay-only events into 6529.io's drop tables. Does nothing when off.
 */
export async function runDropIndex({
  env = process.env,
  factory,
  writes
}: {
  env?: Record<string, string | undefined>;
  factory?: WebSocketFactory;
  writes?: RelayDropWrites;
} = {}): Promise<DropIndexRunReport | null> {
  const config = dropIndexConfig(env);
  if (!config) return null;
  const startedAt = Date.now();
  const readMs = config.apply
    ? Math.floor(config.budgetMs * 0.6)
    : config.budgetMs;
  const subscriber = new DropIndexSubscriber(
    dropIndexDb,
    (relay) => CrpConnection.open(relay, config.net, { factory }),
    () => listeners,
    (message) => logger.info(message),
    config.reader ? readerAuthAnswer(config.reader) : null
  );
  const relays = await subscriber.run({
    ...DEFAULT_DROP_INDEX_RUN,
    relays: config.relays,
    budgetMs: readMs
  });
  if (!config.apply) return { relays, applied: null };
  await dropIndexDb.markSiteWritten();
  // Loaded only when writing: it brings the API's drop write path.
  const drops = writes ?? (await import('./relay-drop-writes')).relayDropWrites;
  const applied = await new RelayDropApplier(dropIndexDb, drops).applyPending({
    limit: APPLY_BATCH,
    deadline: startedAt + config.budgetMs
  });
  return { relays, applied };
}

/** For a loop that does other work: a failure here is logged, not thrown. */
export async function runDropIndexBestEffort(): Promise<void> {
  try {
    const reports = await runDropIndex();
    if (reports) logger.info(`[DROP INDEX] ${JSON.stringify(reports)}`);
  } catch (error) {
    logger.error(`[DROP INDEX FAILED] ${error}`);
  }
}
