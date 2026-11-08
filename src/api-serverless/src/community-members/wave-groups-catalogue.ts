import { createHash, randomInt, randomUUID } from 'node:crypto';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { Logger } from '@/logging';
import {
  getRedisClient,
  WAVE_GROUPS_CACHE_GENERATION_KEY,
  WAVE_GROUPS_CACHE_KEY,
  WAVE_GROUPS_CACHE_REBUILD_LEASE_KEY,
  WAVE_GROUPS_CACHE_STAMP_KEY
} from '@/redis';
import { Time, Timer } from '@/time';

const logger = Logger.get('WAVE_GROUPS_CATALOGUE');

/** How long a rebuild may hold the single-flight lease. */
const REBUILD_LEASE_MS = 10_000;
/** How long a request waits for another's rebuild before rebuilding itself. */
const PEER_WAIT_MAX_MS = 2_000;
const PEER_POLL_MIN_MS = 25;
const PEER_POLL_JITTER_MS = 25;
/**
 * How long past the blob's expiry a process may keep serving its own copy
 * while one request rebuilds. Only for expiry: never after an eviction.
 */
const STALE_AFTER_EXPIRY_MAX_MS = 5_000;

/** What a published blob is: the generation it was built under and its content. */
export interface CatalogueStamp {
  readonly generation: string;
  readonly hash: string;
  readonly bytes: number;
  readonly publishedAt: number;
}

/** One atomic read of the blob's size, its stamp and the current generation. */
export interface CatalogueProbe {
  /** The blob's size in bytes; 0 when it is missing. */
  readonly bytes: number;
  readonly stamp: CatalogueStamp | null;
  readonly generation: string;
}

export interface WaveGroupsCatalogueStore {
  probe(): Promise<CatalogueProbe>;
  readBlob(): Promise<string | null>;
  acquireRebuildLease(): Promise<string | null>;
  releaseRebuildLease(token: string): Promise<void>;
  /**
   * Publishes the blob and its stamp only if the generation is still the one
   * the rebuild read before loading; also releases the lease when given.
   */
  publish(params: {
    readonly payload: string;
    readonly stamp: CatalogueStamp;
    readonly ttlSec: number;
    readonly leaseToken: string | null;
  }): Promise<boolean>;
}

/** Where a request's catalogue came from, for logs and measurement. */
export type CatalogueSource =
  | 'memory'
  | 'redis'
  | 'peer'
  | 'rebuilt'
  | 'stale_after_expiry';

export interface CatalogueRead {
  readonly groups: UserGroupEntity[];
  readonly source: CatalogueSource;
  /** Blob bytes this request transferred from Redis (0 for memory). */
  readonly redisBytes: number;
}

interface MemoryCopy {
  readonly stamp: CatalogueStamp;
  readonly groups: UserGroupEntity[];
}

export interface WaveGroupsCatalogueDeps {
  readonly store: () => WaveGroupsCatalogueStore | null;
  /** Loads the catalogue from the database. */
  readonly load: (timer?: Timer) => Promise<UserGroupEntity[]>;
  readonly ttlSec: () => number;
  /** Reads and parses the blob (wraps the read diagnostics). */
  readonly readAndParse?: (
    read: () => Promise<string | null>,
    timer?: Timer
  ) => Promise<{ groups: UserGroupEntity[]; bytes: number } | null>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const TIMER_PREFIX =
  'whichOfGivenGroupsIsUserEligibleFor->getGivenGroupEntities';

function timed<T>(
  timer: Timer | undefined,
  key: string,
  action: () => Promise<T>
): Promise<T> {
  return Timer.timed(timer, `${TIMER_PREFIX}->${key}`, action);
}

/**
 * The wave-related groups every eligibility computation scores against.
 *
 * Redis holds them as one blob (about 11.6 MB in prod). Each process keeps the
 * parsed blob in memory and, per computation, reads only the blob's stamp
 * (a few bytes) to confirm its copy is current, instead of transferring and
 * parsing the blob every time.
 *
 * Correctness rules:
 * - After an explicit eviction (a group created, a wave created or changed),
 *   no process serves its copy again: evictions bump the generation, and a copy
 *   is current only if the stamp names the current generation and the same
 *   content. Requests then wait for one rebuild (or rebuild themselves) and
 *   never see the evicted catalogue.
 * - When the blob merely expired (its TTL is a safety net; content is very
 *   likely unchanged), a process whose copy is still of the current generation
 *   may serve it for at most a few seconds while one request rebuilds.
 * - A rebuild publishes only under the generation it read before loading, so a
 *   catalogue loaded before an eviction is never published after it.
 */
export class WaveGroupsCatalogue {
  private memory: MemoryCopy | null = null;
  private readonly inFlight = new Map<string, Promise<CatalogueRead>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: WaveGroupsCatalogueDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => Time.millis(ms).sleep());
  }

  /** Drops this process's copy (tests). */
  public forget(): void {
    this.memory = null;
    this.inFlight.clear();
  }

  public async get({
    timer,
    signal
  }: { timer?: Timer; signal?: AbortSignal } = {}): Promise<CatalogueRead> {
    const store = this.deps.store();
    if (!store) {
      const groups = await timed(timer, 'redisUnavailableGetByIds', () =>
        this.deps.load(timer)
      );
      return { groups, source: 'rebuilt', redisBytes: 0 };
    }
    const probe = await timed(timer, 'catalogueProbe', () => store.probe());
    const current = this.currentCopy(probe);
    if (current) return { groups: current, source: 'memory', redisBytes: 0 };
    if (probe.bytes > 0) {
      const fetched = await this.fetch(store, probe, 'redis', timer);
      if (fetched) return fetched;
    }
    return this.onMissing(store, probe, timer, signal);
  }

  /** The memory copy, if the probe proves it is the published content. */
  private currentCopy(probe: CatalogueProbe): UserGroupEntity[] | null {
    const memory = this.memory;
    const stamp = probe.stamp;
    if (
      !memory ||
      !stamp ||
      probe.bytes === 0 ||
      probe.bytes !== stamp.bytes ||
      stamp.generation !== probe.generation ||
      memory.stamp.generation !== stamp.generation ||
      memory.stamp.hash !== stamp.hash
    )
      return null;
    // Same content republished after expiry: keep the copy, take the new time.
    if (memory.stamp.publishedAt !== stamp.publishedAt)
      this.memory = { stamp, groups: memory.groups };
    return memory.groups;
  }

  private async fetch(
    store: WaveGroupsCatalogueStore,
    probe: CatalogueProbe,
    source: CatalogueSource,
    timer?: Timer
  ): Promise<CatalogueRead | null> {
    const read = this.deps.readAndParse
      ? await this.deps.readAndParse(() => store.readBlob(), timer)
      : await defaultReadAndParse(() => store.readBlob(), timer);
    if (!read) return null;
    const stamp = probe.stamp;
    // Keep a copy only when the stamp vouches for exactly these bytes. A blob
    // without a stamp (an older build wrote it) or one replaced since the
    // probe is used for this request but not kept.
    this.memory =
      stamp &&
      stamp.generation === probe.generation &&
      stamp.bytes === read.bytes
        ? { stamp, groups: read.groups }
        : null;
    return { groups: read.groups, source, redisBytes: read.bytes };
  }

  private async onMissing(
    store: WaveGroupsCatalogueStore,
    probe: CatalogueProbe,
    timer?: Timer,
    signal?: AbortSignal
  ): Promise<CatalogueRead> {
    const stale = this.staleCopyAfterExpiry(probe);
    const joined = this.inFlight.get(probe.generation);
    if (joined) {
      if (stale) return stale;
      return joined;
    }
    const token = await store.acquireRebuildLease();
    if (token) return this.rebuildOnce(store, probe.generation, token, timer);
    if (stale) return stale;
    const peer = await timed(timer, 'peerWait', () =>
      this.waitForPeer(store, timer, signal)
    );
    if (peer) return peer;
    return this.rebuildOnce(store, probe.generation, null, timer);
  }

  /**
   * The memory copy, when the blob is missing only because it expired: no
   * stamp left behind (an eviction by an older build deletes only the blob),
   * the same generation (no eviction since), and within a few seconds of the
   * expiry.
   */
  private staleCopyAfterExpiry(probe: CatalogueProbe): CatalogueRead | null {
    const memory = this.memory;
    if (
      !memory ||
      probe.bytes !== 0 ||
      probe.stamp !== null ||
      memory.stamp.generation !== probe.generation
    )
      return null;
    const expiredAt = memory.stamp.publishedAt + this.deps.ttlSec() * 1_000;
    if (this.now() > expiredAt + STALE_AFTER_EXPIRY_MAX_MS) return null;
    return {
      groups: memory.groups,
      source: 'stale_after_expiry',
      redisBytes: 0
    };
  }

  private async waitForPeer(
    store: WaveGroupsCatalogueStore,
    timer?: Timer,
    signal?: AbortSignal
  ): Promise<CatalogueRead | null> {
    const deadline = this.now() + PEER_WAIT_MAX_MS;
    while (this.now() < deadline && !signal?.aborted) {
      await this.sleep(PEER_POLL_MIN_MS + randomInt(PEER_POLL_JITTER_MS + 1));
      const probe = await store.probe();
      if (probe.bytes > 0) {
        const fetched = await this.fetch(store, probe, 'peer', timer);
        if (fetched) return fetched;
        continue;
      }
      // The rebuilding request may have failed: take the rebuild over.
      const token = await store.acquireRebuildLease();
      if (token) return this.rebuildOnce(store, probe.generation, token, timer);
    }
    return null;
  }

  /** One rebuild per generation per process; concurrent misses share it. */
  private rebuildOnce(
    store: WaveGroupsCatalogueStore,
    generation: string,
    leaseToken: string | null,
    timer?: Timer
  ): Promise<CatalogueRead> {
    const existing = this.inFlight.get(generation);
    if (existing) {
      if (leaseToken)
        void store.releaseRebuildLease(leaseToken).catch(() => undefined);
      return existing;
    }
    const rebuild = this.rebuild(store, generation, leaseToken, timer).finally(
      () => {
        if (this.inFlight.get(generation) === rebuild)
          this.inFlight.delete(generation);
      }
    );
    this.inFlight.set(generation, rebuild);
    return rebuild;
  }

  private async rebuild(
    store: WaveGroupsCatalogueStore,
    generation: string,
    leaseToken: string | null,
    timer?: Timer
  ): Promise<CatalogueRead> {
    let published = false;
    try {
      const groups = await timed(timer, 'redisMissGetByIds', () =>
        this.deps.load(timer)
      );
      const payload = await timed(timer, 'redisJsonStringify', async () =>
        JSON.stringify(groups)
      );
      const stamp: CatalogueStamp = {
        generation,
        hash: createHash('sha256').update(payload).digest('base64url'),
        bytes: Buffer.byteLength(payload, 'utf8'),
        publishedAt: this.now()
      };
      try {
        published = await timed(timer, 'redisSet', () =>
          store.publish({
            payload,
            stamp,
            ttlSec: this.deps.ttlSec(),
            leaseToken
          })
        );
      } catch (error) {
        // The blob is a cache: this request still has its catalogue.
        logger.warn(
          'Wave groups catalogue publish failed',
          error instanceof Error ? error.name : 'Unknown'
        );
      }
      // Unpublished means an eviction landed during the load: this request
      // may use what it loaded, but no later one may reuse it.
      if (published) this.memory = { stamp, groups };
      return { groups, source: 'rebuilt', redisBytes: 0 };
    } finally {
      if (leaseToken && !published)
        await store.releaseRebuildLease(leaseToken).catch(() => undefined);
    }
  }
}

async function defaultReadAndParse(
  read: () => Promise<string | null>,
  timer?: Timer
): Promise<{ groups: UserGroupEntity[]; bytes: number } | null> {
  const raw = await timed(timer, 'redisGet', read);
  if (!raw) return null;
  const groups = await timed(timer, 'redisJsonParse', async () =>
    JSON.parse(raw)
  );
  return { groups, bytes: Buffer.byteLength(raw, 'utf8') };
}

function parseStamp(raw: unknown): CatalogueStamp | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.generation === 'string' &&
      typeof parsed.hash === 'string' &&
      Number.isSafeInteger(parsed.bytes) &&
      Number.isSafeInteger(parsed.publishedAt)
    )
      return {
        generation: parsed.generation,
        hash: parsed.hash,
        bytes: parsed.bytes,
        publishedAt: parsed.publishedAt
      };
  } catch {
    // A malformed stamp vouches for nothing.
  }
  return null;
}

/** The Redis implementation; all keys share the blob's cluster slot. */
export class RedisWaveGroupsCatalogueStore implements WaveGroupsCatalogueStore {
  constructor(
    private readonly client: NonNullable<ReturnType<typeof getRedisClient>>
  ) {}

  async probe(): Promise<CatalogueProbe> {
    const result = (await this.client.eval(
      `return {redis.call('STRLEN', KEYS[1]),
        redis.call('GET', KEYS[2]) or false,
        redis.call('GET', KEYS[3]) or false}`,
      {
        keys: [
          WAVE_GROUPS_CACHE_KEY,
          WAVE_GROUPS_CACHE_STAMP_KEY,
          WAVE_GROUPS_CACHE_GENERATION_KEY
        ]
      }
    )) as unknown;
    const [bytes, stamp, generation] = Array.isArray(result) ? result : [];
    return {
      bytes: Number.isSafeInteger(Number(bytes)) ? Number(bytes) : 0,
      stamp: parseStamp(stamp),
      generation: typeof generation === 'string' ? generation : '0'
    };
  }

  readBlob(): Promise<string | null> {
    return this.client.get(WAVE_GROUPS_CACHE_KEY);
  }

  async acquireRebuildLease(): Promise<string | null> {
    const token = randomUUID();
    const acquired = await this.client.set(
      WAVE_GROUPS_CACHE_REBUILD_LEASE_KEY,
      token,
      { NX: true, PX: REBUILD_LEASE_MS }
    );
    return acquired === 'OK' ? token : null;
  }

  async releaseRebuildLease(token: string): Promise<void> {
    await this.client.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then
         return redis.call('DEL', KEYS[1])
       end
       return 0`,
      { keys: [WAVE_GROUPS_CACHE_REBUILD_LEASE_KEY], arguments: [token] }
    );
  }

  async publish({
    payload,
    stamp,
    ttlSec,
    leaseToken
  }: {
    payload: string;
    stamp: CatalogueStamp;
    ttlSec: number;
    leaseToken: string | null;
  }): Promise<boolean> {
    const published = await this.client.eval(
      `if (redis.call('GET', KEYS[3]) or '0') ~= ARGV[1] then return 0 end
       redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
       redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
       if ARGV[5] ~= '' and redis.call('GET', KEYS[4]) == ARGV[5] then
         redis.call('DEL', KEYS[4])
       end
       return 1`,
      {
        keys: [
          WAVE_GROUPS_CACHE_KEY,
          WAVE_GROUPS_CACHE_STAMP_KEY,
          WAVE_GROUPS_CACHE_GENERATION_KEY,
          WAVE_GROUPS_CACHE_REBUILD_LEASE_KEY
        ],
        arguments: [
          stamp.generation,
          payload,
          JSON.stringify(stamp),
          String(Math.max(1, Math.trunc(ttlSec))),
          leaseToken ?? ''
        ]
      }
    );
    return Number(published) === 1;
  }
}
