import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { RelayItem } from '@/rebuild/manifest.types';
import {
  RecordingVerifier,
  RelayVerification
} from '@/rebuild/sources/relay-checks';
import {
  RelayRules,
  RelaySession,
  ReadFilter
} from '@/rebuild/sources/relay-rules';
import {
  closeServer,
  listenLoopback,
  Provenance,
  readProvenance,
  RunningSource
} from '@/rebuild/sources/running-source';

// `ws` is a root devDependency without its types; only the calls used here are typed.
export interface WsSocket {
  send(data: string | Buffer): void;
  close(): void;
  on(event: 'message', listener: (data: Buffer, binary: boolean) => void): void;
  on(event: 'close', listener: () => void): void;
}
interface WsServer {
  on(event: 'connection', listener: (socket: WsSocket) => void): void;
  close(callback?: () => void): void;
}
const { WebSocketServer } = require('ws') as {
  WebSocketServer: new (options: { server: http.Server }) => WsServer;
};

export type Frame = Record<string, unknown> & { t: string };

export interface StoredEvent {
  readonly rseq: number;
  readonly event: {
    id: string;
    wave: string;
    kind?: number;
    body?: string | null;
  };
  readonly grant: { wallet?: string } & Record<string, unknown>;
  /** In a recording: the other fields the relay sent with the event. */
  readonly extra?: Record<string, unknown>;
  /** In a recording: when the recorded run first saw the event (ms). */
  readonly recorded_at?: number;
}

/** What EV frames and HIST items carry beside the event: recorded as sent. */
function served(stored: StoredEvent): Record<string, unknown> {
  return {
    ...(stored.extra ?? {}),
    ...(stored.recorded_at === undefined
      ? {}
      : { recorded_at: stored.recorded_at })
  };
}

/** A live subscription: its waves (`*`: every log). */
interface Subscription {
  readonly sid: unknown;
  readonly waves: readonly string[];
}

interface Session {
  readonly socket: WsSocket;
  /** Set by AUTH: the wallet, its roles and principal, and its grant's end. */
  auth: RelaySession | null;
  readonly subscriptions: Map<unknown, Subscription>;
}

export const EVENTS_FILE = 'events.jsonl';
export const PAYLOADS_DIR = 'payloads';
/** `{ "head": n }`: the finalized chain height WELCOME reports. */
export const RELAY_FILE = 'relay.json';
/** The waves a recorded run read (SUB or HIST); a replay serves only these. */
export const READS_FILE = 'reads.json';
const DEFAULT_HEAD = 1;
/** The relays' log epoch; a cursor of another epoch is no cursor. */
const LOG_EPOCH = 1;
/** A CHALLENGE's life, as on the relays. */
const CHALLENGE_MS = 5 * 60 * 1000;

/** JSON with object keys sorted, so equal values print the same. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((v as Record<string, unknown>)[key])])
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** Payload hashes a record body names (`h` at any depth). */
export function payloadRefs(body: string | null | undefined): string[] {
  if (!body) return [];
  const refs: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (typeof record.h === 'string') refs.push(record.h);
    Object.values(record).forEach(visit);
  };
  try {
    visit(JSON.parse(body));
  } catch {
    return [];
  }
  return refs;
}

export function bareHash(hash: string): string {
  return hash.replace(/^0x/, '').toLowerCase();
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function decodeBinary(data: Buffer): { header: Frame; bytes: Buffer } {
  const length = data.readUInt32BE(0);
  const header = JSON.parse(data.subarray(4, 4 + length).toString('utf8'));
  return { header, bytes: data.subarray(4 + length) };
}

function encodeBinary(header: Record<string, unknown>, bytes: Buffer): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(headerBytes.length, 0);
  return Buffer.concat([prefix, headerBytes, bytes]);
}

/**
 * The log an event belongs to: a family wave (`dv/0x..`, with `/`) is
 * logged under its family code (`dv`), any other wave under its own name.
 * rseq counts per log from 1, as on the relays.
 */
export function logOf(wave: string): string {
  const slash = wave.indexOf('/');
  return slash < 0 ? wave : wave.slice(0, slash);
}

/**
 * The relay store behind the harness's relay: CRP v1 frames (HELLO, AUTH,
 * PUB, payload put and get, SUB, HIST) over what clients published, kept in
 * a directory so a seed's records are there for the rebuild. Each log (a
 * wave, or a family of streams) counts its own rseq from 1. It checks what
 * the relays' clients depend on (one copy per event id, a LOG `seq` taken
 * once per wave, payloads before the records that name them) but not
 * signatures: it is a store for the run, not a trust boundary.
 *
 * With `replay`, the directory is a recording and the store never changes:
 * a PUB is taken only when it repeats a recorded event and its grant (as
 * canonical JSON), and a payload only when it is recorded.
 */
export class CrpRelayStore {
  /** Every event in the order it arrived. */
  private readonly events: StoredEvent[] = [];
  /** Each log's events in rseq order. */
  private readonly logs = new Map<string, StoredEvent[]>();
  private readonly byId = new Map<string, StoredEvent>();
  private readonly logSeqs = new Map<string, string>();
  /** In a replay, the waves the recorded run read; null when unknown. */
  private readonly reads: Set<string> | null;
  /** The chain height the relay says is final (clients anchor records to it). */
  readonly head: number;

  constructor(
    private readonly dir: string,
    readonly replay = false
  ) {
    if (!replay) {
      fs.mkdirSync(path.join(dir, PAYLOADS_DIR), { recursive: true });
    }
    const relayFile = path.join(dir, RELAY_FILE);
    this.head = fs.existsSync(relayFile)
      ? Number(JSON.parse(fs.readFileSync(relayFile, 'utf8')).head)
      : DEFAULT_HEAD;
    const readsFile = path.join(dir, READS_FILE);
    this.reads = fs.existsSync(readsFile)
      ? new Set(JSON.parse(fs.readFileSync(readsFile, 'utf8')) as string[])
      : null;
    const eventsFile = path.join(dir, EVENTS_FILE);
    if (fs.existsSync(eventsFile)) {
      for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n')) {
        if (line.trim()) this.remember(JSON.parse(line) as StoredEvent);
      }
    }
    this.logs.forEach((log) => log.sort((a, b) => a.rseq - b.rseq));
  }

  get size(): number {
    return this.events.length;
  }

  /** Every stored event with its grant, in arrival order. */
  items(): RelayItem[] {
    return this.events.map((stored) => ({
      event: stored.event,
      grant: stored.grant
    }));
  }

  /** Every stored event, in arrival order. */
  all(): readonly StoredEvent[] {
    return this.events;
  }

  /** The names of the logs the relay holds, in the order they began. */
  logNames(): string[] {
    return Array.from(this.logs.keys());
  }

  private remember(stored: StoredEvent): void {
    this.events.push(stored);
    const name = logOf(stored.event.wave);
    const log = this.logs.get(name) ?? [];
    log.push(stored);
    this.logs.set(name, log);
    this.byId.set(stored.event.id, stored);
    if (stored.event.kind === 11) {
      this.logSeqs.set(this.seqKey(stored.event), stored.event.id);
    }
  }

  private seqKey(event: StoredEvent['event']): string {
    const seq = String(JSON.parse(event.body ?? '{}').seq);
    return `${event.wave}#${seq}`;
  }

  /** In a replay, whether the recorded run read `wave` (or every wave). */
  wasRead(wave: string): boolean {
    return (this.reads?.has(wave) || this.reads?.has('*')) ?? false;
  }

  hasPayload(hash: string): boolean {
    return fs.existsSync(path.join(this.dir, PAYLOADS_DIR, bareHash(hash)));
  }

  payload(hash: string): Buffer | null {
    const file = path.join(this.dir, PAYLOADS_DIR, bareHash(hash));
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }

  /** Payload files whose bytes don't hash to their name. */
  badPayloads(): string[] {
    const dir = path.join(this.dir, PAYLOADS_DIR);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(
        (name) => sha256Hex(fs.readFileSync(path.join(dir, name))) !== name
      );
  }

  /** Stores a payload whose bytes hash to `hash`. */
  putPayload(
    hash: string,
    bytes: Buffer
  ): 'accepted' | 'duplicate' | 'rejected' {
    const digest = sha256Hex(bytes);
    if (digest !== bareHash(hash)) return 'rejected';
    if (this.hasPayload(hash)) return 'duplicate';
    if (this.replay) return 'rejected';
    fs.writeFileSync(path.join(this.dir, PAYLOADS_DIR, digest), bytes);
    return 'accepted';
  }

  /**
   * Stores an event: `accepted` with the stored event, `duplicate`, or a
   * rejection reason.
   */
  publish(
    event: StoredEvent['event'],
    grant: StoredEvent['grant']
  ): { result: string; stored?: StoredEvent } {
    const known = this.byId.get(event.id);
    if (this.replay) {
      if (!known) return { result: 'not in the recording' };
      const same =
        canonicalJson(known.event) === canonicalJson(event) &&
        canonicalJson(known.grant) === canonicalJson(grant ?? {});
      return { result: same ? 'duplicate' : 'differs from the recording' };
    }
    if (known) return { result: 'duplicate' };
    const missing = payloadRefs(event.body).find(
      (ref) => !this.hasPayload(ref)
    );
    if (missing) return { result: `payload ${missing}` };
    if (event.kind === 11) {
      const taken = this.logSeqs.get(this.seqKey(event));
      if (taken && taken !== event.id) return { result: 'seq-taken' };
    }
    const stored: StoredEvent = {
      rseq: this.headOf(logOf(event.wave)) + 1,
      event,
      grant
    };
    this.remember(stored);
    fs.appendFileSync(
      path.join(this.dir, EVENTS_FILE),
      `${JSON.stringify(stored)}\n`
    );
    return { result: 'accepted', stored };
  }

  /** The newest rseq of a log, 0 when it holds nothing. */
  headOf(log: string): number {
    const events = this.logs.get(log);
    return events?.length ? events[events.length - 1].rseq : 0;
  }

  /** Every event of the log `wave` belongs to, for read decisions. */
  logOfWave(wave: string): readonly StoredEvent[] {
    return this.logs.get(logOf(wave)) ?? [];
  }

  /**
   * A wave's events after `after`, in rseq order: a log's (a wave, or a
   * family by its code), or one stream of a family (`dv/0x..`: the family's
   * log filtered to it, with the family's rseq).
   */
  matching(wave: string, after = 0): StoredEvent[] {
    return this.logOfWave(wave).filter(
      (e) => e.rseq > after && (!wave.includes('/') || e.event.wave === wave)
    );
  }
}

/** Problems a replay finds, counted by kind with the first of each. */
class ReplayProblems {
  private readonly kinds = new Map<string, { count: number; first: string }>();

  add(kind: string, first: string): void {
    const seen = this.kinds.get(kind);
    if (seen) seen.count += 1;
    else this.kinds.set(kind, { count: 1, first });
  }

  list(): string[] {
    return Array.from(this.kinds.entries()).map(
      ([kind, { count, first }]) => `relays: ${count} ${kind}, first ${first}`
    );
  }
}

/** An EV frame for one stored event, under the wave it was asked for. */
function evFrame(sid: unknown, wave: string, item: StoredEvent) {
  return {
    t: 'EV',
    sid,
    wave,
    log_epoch: LOG_EPOCH,
    rseq: item.rseq,
    event: item.event,
    grant: item.grant,
    receipts: [],
    ...served(item)
  };
}

/** The events of `wave` after `after` that a read decision keeps. */
function readable(
  store: CrpRelayStore,
  filter: ReadFilter,
  wave: string,
  after = 0
): StoredEvent[] {
  if (filter === 'none') return [];
  const events = store.matching(wave, after);
  return filter === 'all' ? events : events.filter((e) => filter(e.event));
}

/** Whether a live subscription's `wave` (`*`, a log or a stream) covers an event. */
function covers(wave: string, item: StoredEvent): boolean {
  return (
    wave === '*' ||
    wave === item.event.wave ||
    (!wave.includes('/') && wave === logOf(item.event.wave))
  );
}

function handleFrame(
  store: CrpRelayStore,
  rules: RelayRules,
  session: Session,
  frame: Frame,
  problems: ReplayProblems | null,
  live: (stored: StoredEvent) => void
) {
  const send = (reply: Record<string, unknown>) =>
    session.socket.send(JSON.stringify(reply));
  const filterOf = (wave: string) =>
    rules.filter(
      session.auth,
      wave,
      store.logOfWave(wave).map((e) => e.event)
    );
  const noteRead = (wave: string) => {
    if (problems && !store.wasRead(wave)) {
      problems.add('reads of waves the recorded run never read', wave);
    }
  };
  switch (frame.t) {
    case 'HELLO':
      send({
        t: 'WELCOME',
        v: 1,
        relay_id: 'rebuild-relay',
        log_epoch: LOG_EPOCH,
        net: frame.net,
        head: store.head
      });
      send({
        t: 'CHALLENGE',
        nonce: `0x${'00'.repeat(32)}`,
        expires: Date.now() + CHALLENGE_MS
      });
      return;
    case 'AUTH': {
      // The harness checks no signature: AUTH names the grant's wallet, and
      // the areas' declared readers give it roles.
      const grant = (frame.grant ?? {}) as Record<string, unknown>;
      session.auth = rules.session(String(grant.wallet ?? ''), grant);
      send({
        t: 'AUTHED',
        rid: frame.rid,
        wallet: session.auth.wallet,
        principal: session.auth.principal,
        roles: session.auth.roles
      });
      return;
    }
    case 'PUB': {
      const event = frame.event as StoredEvent['event'];
      const { result, stored } = store.publish(
        event,
        (frame.grant ?? {}) as StoredEvent['grant']
      );
      const accepted = result === 'accepted' || result === 'duplicate';
      if (problems && !accepted) {
        problems.add(
          'published events the recording does not hold',
          `${event.id} in ${event.wave} (${result})`
        );
      }
      send({
        t: 'ACK',
        rid: frame.rid,
        event_id: event.id,
        status: accepted ? result : 'rejected',
        reason: accepted ? null : result,
        host_ack: null
      });
      if (stored) live(stored);
      return;
    }
    case 'PAYLOAD_GET': {
      // Payloads are private families' attachments: an AUTHed session's.
      const bytes = session.auth ? store.payload(String(frame.sha256)) : null;
      if (!bytes) {
        problems?.add(
          'payloads asked for and not recorded',
          String(frame.sha256)
        );
        send({ t: 'ERR', rid: frame.rid, reason: 'not found' });
        return;
      }
      session.socket.send(
        encodeBinary(
          {
            t: 'PAYLOAD',
            rid: frame.rid,
            sha256: frame.sha256,
            len: bytes.length
          },
          bytes
        )
      );
      return;
    }
    case 'SUB': {
      // Each wave in turn: after its cursor (one of this epoch), from the
      // start when there is none and from_start, else live events only. A
      // named wave the session may not read ends at once (EOSE rseq 0);
      // under `*` it is passed over.
      const since = new Map(
        (
          (frame.since as {
            wave?: string;
            log_epoch?: number;
            rseq?: number;
          }[]) ?? []
        )
          .filter((cursor) => Number(cursor.log_epoch) === LOG_EPOCH)
          .map((cursor) => [String(cursor.wave), Number(cursor.rseq ?? 0)])
      );
      const waves = (frame.waves as string[]) ?? [];
      waves.forEach(noteRead);
      for (const asked of waves) {
        for (const wave of asked === '*' ? store.logNames() : [asked]) {
          const filter = filterOf(wave);
          if (filter === 'none') {
            if (asked !== '*') {
              send({ t: 'EOSE', sid: frame.sid, wave, rseq: 0 });
            }
            continue;
          }
          const cursor = since.get(wave);
          if (cursor === undefined && frame.from_start !== true) continue;
          const events = readable(store, filter, wave, cursor ?? 0);
          events.forEach((item) => send(evFrame(frame.sid, wave, item)));
          const all = readable(store, filter, wave);
          send({
            t: 'EOSE',
            sid: frame.sid,
            wave,
            rseq: all.length ? all[all.length - 1].rseq : 0
          });
        }
      }
      session.subscriptions.set(frame.sid, { sid: frame.sid, waves });
      return;
    }
    case 'HIST': {
      const wave = String(frame.wave);
      noteRead(wave);
      const filter = filterOf(wave);
      if (filter === 'none') {
        send({ t: 'ERR', rid: frame.rid, reason: `${wave}: not readable` });
        return;
      }
      const limit = Number(frame.limit);
      const newest = frame.after === null || frame.after === undefined;
      const all = readable(
        store,
        filter,
        wave,
        newest ? 0 : Number(frame.after)
      );
      // Without `after`, the newest page.
      const page = newest
        ? all.slice(Math.max(0, all.length - limit))
        : all.slice(0, limit);
      send({
        t: 'RES',
        rid: frame.rid,
        log_epoch: LOG_EPOCH,
        items: page.map((item) => ({
          rseq: item.rseq,
          event: item.event,
          grant: item.grant,
          ...served(item)
        })),
        more: all.length > limit
      });
      return;
    }
    case 'UNSUB':
      session.subscriptions.delete(frame.sid);
      return;
    default:
      send({ t: 'ERR', rid: frame.rid ?? null, reason: 'unknown frame' });
  }
}

/** Serves a store on loopback over CRP v1, with live EVs to subscribers. */
async function serveStore(
  store: CrpRelayStore,
  rules: RelayRules,
  problems: ReplayProblems | null
): Promise<{
  url: string;
  errors: string[];
  stop(): Promise<void>;
}> {
  const errors: string[] = [];
  const sessions = new Set<Session>();
  const live = (stored: StoredEvent) => {
    sessions.forEach((session) => {
      session.subscriptions.forEach((subscription) => {
        const wave = subscription.waves.find((w) => covers(w, stored));
        if (wave === undefined) return;
        const named = wave === '*' ? logOf(stored.event.wave) : wave;
        const filter = rules.filter(
          session.auth,
          named,
          store.logOfWave(named).map((e) => e.event)
        );
        if (filter === 'none') return;
        if (filter !== 'all' && !filter(stored.event)) return;
        session.socket.send(
          JSON.stringify(evFrame(subscription.sid, named, stored))
        );
      });
    });
  };
  const server = http.createServer((_request, response) => {
    response.writeHead(426);
    response.end();
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) => {
    const session: Session = {
      socket,
      auth: null,
      subscriptions: new Map()
    };
    sessions.add(session);
    socket.on('close', () => sessions.delete(session));
    socket.on('message', (data, binary) => {
      try {
        if (binary) {
          const { header, bytes } = decodeBinary(data);
          const status = session.auth
            ? store.putPayload(String(header.sha256), bytes)
            : 'rejected';
          if (problems && status === 'rejected') {
            problems.add(
              'payloads put that the recording does not hold',
              String(header.sha256)
            );
          }
          socket.send(
            JSON.stringify({
              t: 'ACK',
              rid: header.rid,
              event_id: header.sha256,
              status,
              reason: status === 'rejected' ? 'hash or auth' : null,
              host_ack: null
            })
          );
          return;
        }
        handleFrame(
          store,
          rules,
          session,
          JSON.parse(data.toString('utf8')) as Frame,
          problems,
          live
        );
      } catch (error) {
        errors.push(String(error));
        socket.send(
          JSON.stringify({ t: 'ERR', rid: null, reason: 'bad frame' })
        );
      }
    });
  });
  const { port } = await listenLoopback(server);
  return {
    url: `ws://127.0.0.1:${port}`,
    errors,
    stop: async () => {
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await closeServer(server);
    }
  };
}

/**
 * The harness's relay on loopback, keeping what is published in `dir`. It
 * reads as the relays do (see RelayRules) but checks no signatures, so it
 * is never a final source.
 */
export async function startCrpRelay(
  dir: string,
  rules: RelayRules
): Promise<RunningSource> {
  const store = new CrpRelayStore(dir);
  const provenance = readProvenance(dir);
  const served = await serveStore(store, rules, null);
  return {
    name: 'relays',
    url: served.url,
    info: {
      url: served.url,
      mode: 'local',
      provenance:
        provenance?.made_by ??
        `the harness relay, ${store.size} events in ${dir}`,
      provisional: true
    },
    problems: () =>
      served.errors.length
        ? [
            `relays: ${served.errors.length} bad frames, first ${served.errors[0]}`
          ]
        : [],
    stop: served.stop
  };
}

/** Why one replayed recording counts for a final run, or why it doesn't. */
interface RecordingJudgement {
  readonly text: string;
  readonly final: boolean;
}

/**
 * A recording counts for a final run only when it has events and every
 * one passes the signed-event check (its id recomputed, its device key's
 * signature verified) and its area's relay check. PROVENANCE.json's
 * `made_by` and `devnet_scenario` are labels for the report, never a basis.
 */
function judgeRecording(
  dir: string,
  verification: RelayVerification,
  store: CrpRelayStore,
  problems: ReplayProblems
): RecordingJudgement {
  const provenance = readProvenance(dir) as
    | (Provenance & { devnet_scenario?: unknown })
    | null;
  for (const failure of verification.failed) {
    problems.add(
      'recorded events that fail their checks',
      `${failure.id} in ${failure.wave}: ${failure.reason}`
    );
  }
  for (const name of store.badPayloads()) {
    problems.add("recorded payloads that don't match their hash", name);
  }
  const unchecked = Object.entries(verification.unchecked);
  const uncheckedCount = unchecked.reduce((n, [, count]) => n + count, 0);
  const checked = [
    `${verification.verified} of ${verification.events} events pass the signed-event check and their area's`,
    ...(uncheckedCount
      ? [
          `${uncheckedCount} in waves no area's check covers (${unchecked
            .map(([wave]) => wave)
            .slice(0, 5)
            .join(', ')})`
        ]
      : [])
  ].join(', ');
  const final =
    verification.events > 0 && verification.verified === verification.events;
  const label = [
    typeof provenance?.made_by === 'string' && provenance.made_by.trim()
      ? provenance.made_by.trim()
      : 'no made_by',
    typeof provenance?.devnet_scenario === 'string'
      ? `devnet scenario ${provenance.devnet_scenario}`
      : null
  ]
    .filter(Boolean)
    .join(', ');
  return {
    text: `${label} (${final ? 'final' : 'provisional'}; ${checked})`,
    final
  };
}

/**
 * One recording made of several (`a+b`) in `dir`: each one's events in its
 * own order after the one before (rseq counted again per log), with their
 * payloads and reads.
 */
function mergeRecordings(dirs: readonly string[], dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, PAYLOADS_DIR), { recursive: true });
  const events: string[] = [];
  const reads = new Set<string>();
  let head = DEFAULT_HEAD;
  const heads = new Map<string, number>();
  for (const from of dirs) {
    const store = new CrpRelayStore(from, true);
    for (const stored of store.all()) {
      const log = logOf(stored.event.wave);
      const rseq = (heads.get(log) ?? 0) + 1;
      heads.set(log, rseq);
      events.push(JSON.stringify({ ...stored, rseq }));
    }
    head = Math.max(head, store.head);
    const readsFile = path.join(from, READS_FILE);
    if (fs.existsSync(readsFile)) {
      (JSON.parse(fs.readFileSync(readsFile, 'utf8')) as string[]).forEach(
        (wave) => reads.add(wave)
      );
    }
    const payloads = path.join(from, PAYLOADS_DIR);
    if (fs.existsSync(payloads)) {
      for (const name of fs.readdirSync(payloads)) {
        fs.copyFileSync(
          path.join(payloads, name),
          path.join(dir, PAYLOADS_DIR, name)
        );
      }
    }
  }
  fs.writeFileSync(
    path.join(dir, EVENTS_FILE),
    events.map((line) => `${line}\n`).join('')
  );
  fs.writeFileSync(
    path.join(dir, READS_FILE),
    JSON.stringify(Array.from(reads))
  );
  fs.writeFileSync(path.join(dir, RELAY_FILE), JSON.stringify({ head }));
}

/**
 * Relay recordings served read-only, by the same read rules as the
 * harness relay. Each is judged on its own (see judgeRecording): an event
 * that fails a check is a problem, and a recording that isn't final keeps
 * the source provisional. Several recordings (an area's each) are merged
 * into `mergeDir` for the run.
 */
export async function startCrpRelayReplay(
  dirs: readonly string[],
  verify: RecordingVerifier,
  mergeDir: string,
  rules: RelayRules
): Promise<RunningSource> {
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(dir, EVENTS_FILE))) {
      throw new Error(`relays: no recording at ${dir}`);
    }
  }
  const problems = new ReplayProblems();
  const verifications = await verify(dirs);
  const judgements = dirs.map((dir, i) =>
    judgeRecording(
      dir,
      verifications[i],
      new CrpRelayStore(dir, true),
      problems
    )
  );
  if (dirs.length > 1) mergeRecordings(dirs, mergeDir);
  const store = new CrpRelayStore(dirs.length > 1 ? mergeDir : dirs[0], true);
  const served = await serveStore(store, rules, problems);
  return {
    name: 'relays',
    url: served.url,
    info: {
      url: served.url,
      mode: 'replay',
      provenance: judgements.map((j) => j.text).join(' + '),
      provisional: judgements.some((j) => !j.final)
    },
    problems: () => [
      ...problems.list(),
      ...(served.errors.length
        ? [
            `relays: ${served.errors.length} bad frames, first ${served.errors[0]}`
          ]
        : [])
    ],
    stop: served.stop
  };
}
