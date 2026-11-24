import { AreaManifest, RelayRole } from '@/rebuild/manifest.types';

/** What the harness relay knows of one stored event, for a read decision. */
export interface ReadableEvent {
  readonly id?: string;
  readonly wave: string;
  readonly kind?: number;
  readonly refs?: readonly string[];
  readonly anchor?: number;
  readonly claimed_time?: number;
  readonly body?: string | null;
}

/** An authenticated session: who answered the challenge, and until when. */
export interface RelaySession {
  readonly wallet: string;
  readonly principal: string | null;
  readonly roles: readonly RelayRole[];
  /** Members-only waves of drops its principal may read. */
  readonly memberOf: readonly string[];
  /** The grant's end (expiry, or revocation if earlier), ms; null: none. */
  readonly until: number | null;
}

/** A read decision: everything, nothing, or the events a filter keeps. */
export type ReadFilter = 'all' | 'none' | ((event: ReadableEvent) => boolean);

/** wave-inbox's families; `ps` is public, the rest are private. */
const FAMILIES = new Set(['ps', 'pv', 'dr', 'dv', 'cv', 'bl', 'bk', 'md']);
const RECORD_KIND = 9;

/** A family wave's family and owner (`dv/0x..`), or null for a wave. */
export function familyOf(
  wave: string
): { family: string; owner: string | null } | null {
  const slash = wave.indexOf('/');
  if (slash < 0) {
    return FAMILIES.has(wave) ? { family: wave, owner: null } : null;
  }
  return { family: wave.slice(0, slash), owner: wave.slice(slash + 1) };
}

/** A `pv` reader record's effect for its wallet. */
interface ReaderRecord {
  readonly wallet: string;
  /** A grant (a body) or a revocation (none). */
  readonly active: boolean;
  /** When the grant runs out, ms; null: never. */
  readonly until: number | null;
}

/**
 * A `pv` reader record, as wave-inbox reads one (checks.rs): a record
 * (kind 9) with refs `["reader", <wallet>]`; a body of `{}` or
 * `{"until": <ms>}` grants the wallet the stream, and none revokes it.
 * Anything else is not a reader record.
 */
function readerRecord(event: ReadableEvent): ReaderRecord | null {
  const refs = event.refs ?? [];
  if (event.kind !== RECORD_KIND || refs.length !== 2 || refs[0] !== 'reader')
    return null;
  const wallet = refs[1];
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return null;
  if (event.body === null || event.body === undefined) {
    return { wallet, active: false, until: null };
  }
  try {
    const body = JSON.parse(event.body) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const keys = Object.keys(body);
    if (!keys.length) return { wallet, active: true, until: null };
    const until = (body as { until?: unknown }).until;
    return keys.length === 1 &&
      typeof until === 'number' &&
      Number.isSafeInteger(until) &&
      until >= 0
      ? { wallet, active: true, until }
      : null;
  } catch {
    return null;
  }
}

/** Whether `a` comes after `b` in the inbox's order: anchor, time, id. */
function after(a: ReadableEvent, b: ReadableEvent): boolean {
  const key = (e: ReadableEvent) =>
    [e.anchor ?? 0, e.claimed_time ?? 0, e.id ?? ''] as const;
  const [x, y] = [key(a), key(b)];
  if (x[0] !== y[0]) return x[0] > y[0];
  if (x[1] !== y[1]) return x[1] > y[1];
  return x[2] > y[2];
}

/**
 * The owners whose `pv` stream `wallet` may read at `now`: those whose
 * newest reader record for the wallet grants it and hasn't run out
 * (store.rs reader_active).
 */
function grantingOwners(
  log: readonly ReadableEvent[],
  wallet: string,
  now: number
): Set<string> {
  const newest = new Map<
    string,
    { event: ReadableEvent; record: ReaderRecord }
  >();
  for (const event of log) {
    const record = readerRecord(event);
    const owner = familyOf(event.wave)?.owner;
    if (!record || record.wallet !== wallet || !owner) continue;
    const known = newest.get(owner);
    if (!known || after(event, known.event)) {
      newest.set(owner, { event, record });
    }
  }
  return new Set(
    Array.from(newest.entries())
      .filter(
        ([, { record }]) =>
          record.active && (record.until === null || now < record.until)
      )
      .map(([owner]) => owner)
  );
}

/**
 * Who may read what on the harness relay, as on the relays
 * (crates/wave-relay with the wave-inbox extension):
 * - a wave of drops is open when the areas declare it open; any other is
 *   members-only, read only by the site reader or a principal the areas
 *   declare a member of it (may_read, where wave-inbox's reader reads all
 *   only as the site reader);
 * - the `ps` family is public;
 * - every other family needs a session whose grant is still active: `pv`
 *   streams by their owner, or by a wallet while the owner's newest reader
 *   record for it grants it and hasn't run out (a wallet also reads the
 *   reader records that name it); the rest by the orderer or the site
 *   reader, and `bk` streams also by their owner.
 * Roles, principals and memberships come from the areas' declared readers
 * only; a wallet no area names has none.
 */
export class RelayRules {
  constructor(
    private readonly openWaves: ReadonlySet<string>,
    private readonly readers: ReadonlyMap<
      string,
      {
        roles: readonly RelayRole[];
        principal: string | null;
        memberOf?: readonly string[];
      }
    >
  ) {}

  /** The areas' declared open waves and readers. */
  static of(manifests: readonly AreaManifest[]): RelayRules {
    const open = new Set<string>();
    const readers = new Map<
      string,
      { roles: RelayRole[]; principal: string | null; memberOf: string[] }
    >();
    for (const manifest of manifests) {
      manifest.relayAccess?.openWaves?.forEach((wave) => open.add(wave));
      for (const reader of manifest.relayAccess?.readers ?? []) {
        const wallet = reader.wallet.toLowerCase();
        const known = readers.get(wallet) ?? {
          roles: [],
          principal: null,
          memberOf: []
        };
        readers.set(wallet, {
          roles: Array.from(new Set([...known.roles, ...(reader.roles ?? [])])),
          principal: reader.principal?.toLowerCase() ?? known.principal,
          memberOf: Array.from(
            new Set([...known.memberOf, ...(reader.memberOf ?? [])])
          )
        });
      }
    }
    return new RelayRules(open, readers);
  }

  /** The session an AUTH starts for a wallet under a grant. */
  session(
    wallet: string,
    grant: Readonly<Record<string, unknown>>
  ): RelaySession {
    const reader = this.readers.get(wallet.toLowerCase());
    const ends = [grant.expires_at, grant.revoked_at].filter(
      (t): t is number => typeof t === 'number'
    );
    return {
      wallet: wallet.toLowerCase(),
      principal: reader?.principal ?? null,
      roles: reader?.roles ?? [],
      memberOf: reader?.memberOf ?? [],
      until: ends.length ? Math.min(...ends) : null
    };
  }

  /**
   * What `session` may read of `wave` (a wave, a family by its code, or
   * one stream of a family), given the stored events of its log.
   */
  filter(
    session: RelaySession | null,
    wave: string,
    log: readonly ReadableEvent[],
    now = Date.now()
  ): ReadFilter {
    const family = familyOf(wave);
    if (!family) {
      if (this.openWaves.has(wave)) return 'all';
      if (!session || !active(session, now)) return 'none';
      const member =
        session.principal !== null && session.memberOf.includes(wave);
      return session.roles.includes('site-reader') || member ? 'all' : 'none';
    }
    if (family.family === 'ps') return 'all';
    if (!session || !active(session, now)) return 'none';
    if (family.family === 'pv') {
      // As access.rs allows: the session's own stream, the reader records
      // that name its wallet (so it learns of a grant), and the streams
      // whose newest reader record for the wallet grants it now.
      const granting = grantingOwners(log, session.wallet, now);
      return (e) => {
        const owner = familyOf(e.wave)?.owner ?? null;
        if (owner === null) return false;
        if (owner === session.principal) return true;
        if (readerRecord(e)?.wallet === session.wallet) return true;
        return granting.has(owner);
      };
    }
    if (session.roles.length) return 'all';
    if (family.family === 'bk' && session.principal) {
      return (e) => familyOf(e.wave)?.owner === session.principal;
    }
    return 'none';
  }
}

function active(session: RelaySession, now: number): boolean {
  return session.until === null || now < session.until;
}
