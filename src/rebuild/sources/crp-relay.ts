import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  closeServer,
  isProvisional,
  listenLoopback,
  readProvenance,
  RunningSource
} from '@/rebuild/sources/running-source';

// `ws` is a root devDependency without its types; only the calls used here are typed.
interface WsSocket {
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

type Frame = Record<string, unknown> & { t: string };

interface StoredEvent {
  readonly rseq: number;
  readonly event: {
    id: string;
    wave: string;
    kind?: number;
    body?: string | null;
  };
  readonly grant: { wallet?: string } & Record<string, unknown>;
}

interface Session {
  readonly socket: WsSocket;
  wallet: string | null;
  roles: string[];
}

const EVENTS_FILE = 'events.jsonl';
const PAYLOADS_DIR = 'payloads';
const ROLES_FILE = 'roles.json';
/** `{ "head": n }`: the finalized chain height WELCOME reports. */
const RELAY_FILE = 'relay.json';
const DEFAULT_HEAD = 1;
const ALL_ROLES = ['orderer', 'site-reader'];

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

function bareHash(hash: string): string {
  return hash.replace(/^0x/, '').toLowerCase();
}

function decodeBinary(data: Buffer): { header: Frame; bytes: Buffer } {
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
 * The relay store behind the harness's relay: CRP v1 frames (HELLO, AUTH,
 * PUB, payload put and get, SUB, HIST) over what clients published, kept in
 * a directory so a seed's records are there for the rebuild. It checks what
 * the relays' clients depend on (one copy per event id, a LOG `seq` taken
 * once per wave, payloads before the records that name them) but not
 * signatures: it is a store for the run, not a trust boundary.
 */
export class CrpRelayStore {
  private readonly events: StoredEvent[] = [];
  private readonly byId = new Set<string>();
  private readonly logSeqs = new Map<string, string>();
  private readonly roles: Record<string, string[]>;
  /** The chain height the relay says is final (clients anchor records to it). */
  readonly head: number;
  private rseq = 0;

  constructor(private readonly dir: string) {
    fs.mkdirSync(path.join(dir, PAYLOADS_DIR), { recursive: true });
    const rolesFile = path.join(dir, ROLES_FILE);
    this.roles = fs.existsSync(rolesFile)
      ? JSON.parse(fs.readFileSync(rolesFile, 'utf8'))
      : {};
    const relayFile = path.join(dir, RELAY_FILE);
    this.head = fs.existsSync(relayFile)
      ? Number(JSON.parse(fs.readFileSync(relayFile, 'utf8')).head)
      : DEFAULT_HEAD;
    const eventsFile = path.join(dir, EVENTS_FILE);
    if (fs.existsSync(eventsFile)) {
      for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n')) {
        if (line.trim()) this.remember(JSON.parse(line) as StoredEvent);
      }
    }
  }

  get size(): number {
    return this.events.length;
  }

  private remember(stored: StoredEvent): void {
    this.events.push(stored);
    this.byId.add(stored.event.id);
    this.rseq = Math.max(this.rseq, stored.rseq);
    if (stored.event.kind === 11) {
      this.logSeqs.set(this.seqKey(stored.event), stored.event.id);
    }
  }

  private seqKey(event: StoredEvent['event']): string {
    const seq = String(JSON.parse(event.body ?? '{}').seq);
    return `${event.wave}#${seq}`;
  }

  rolesOf(wallet: string): string[] {
    return this.roles[wallet.toLowerCase()] ?? ALL_ROLES;
  }

  hasPayload(hash: string): boolean {
    return fs.existsSync(path.join(this.dir, PAYLOADS_DIR, bareHash(hash)));
  }

  payload(hash: string): Buffer | null {
    const file = path.join(this.dir, PAYLOADS_DIR, bareHash(hash));
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }

  /** Stores a payload whose bytes hash to `hash`. */
  putPayload(
    hash: string,
    bytes: Buffer
  ): 'accepted' | 'duplicate' | 'rejected' {
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== bareHash(hash)) return 'rejected';
    if (this.hasPayload(hash)) return 'duplicate';
    fs.writeFileSync(path.join(this.dir, PAYLOADS_DIR, digest), bytes);
    return 'accepted';
  }

  /** Stores an event: `accepted`, `duplicate`, or a rejection reason. */
  publish(event: StoredEvent['event'], grant: StoredEvent['grant']): string {
    if (this.byId.has(event.id)) return 'duplicate';
    const missing = payloadRefs(event.body).find(
      (ref) => !this.hasPayload(ref)
    );
    if (missing) return `payload ${missing}`;
    if (event.kind === 11) {
      const taken = this.logSeqs.get(this.seqKey(event));
      if (taken && taken !== event.id) return 'seq-taken';
    }
    const stored: StoredEvent = { rseq: this.rseq + 1, event, grant };
    this.remember(stored);
    fs.appendFileSync(
      path.join(this.dir, EVENTS_FILE),
      `${JSON.stringify(stored)}\n`
    );
    return 'accepted';
  }

  /** Events of a wave and its sub-waves after `after`, in relay order. */
  matching(wave: string, after = 0): StoredEvent[] {
    return this.events.filter(
      (e) =>
        (e.event.wave === wave || e.event.wave.startsWith(`${wave}/`)) &&
        e.rseq > after
    );
  }

  get lastSeq(): number {
    return this.rseq;
  }
}

function handleFrame(store: CrpRelayStore, session: Session, frame: Frame) {
  const send = (reply: Record<string, unknown>) =>
    session.socket.send(JSON.stringify(reply));
  const mayRead = session.roles.length > 0;
  switch (frame.t) {
    case 'HELLO':
      send({
        t: 'WELCOME',
        v: 1,
        relay_id: 'rebuild-relay',
        log_epoch: 1,
        net: frame.net,
        head: store.head
      });
      send({ t: 'CHALLENGE', nonce: `0x${'00'.repeat(32)}`, expires: 0 });
      return;
    case 'AUTH': {
      const wallet = String(
        (frame.grant as { wallet?: string })?.wallet ?? ''
      ).toLowerCase();
      session.wallet = wallet;
      session.roles = store.rolesOf(wallet);
      send({
        t: 'AUTHED',
        rid: frame.rid,
        wallet,
        principal: null,
        roles: session.roles
      });
      return;
    }
    case 'PUB': {
      const event = frame.event as StoredEvent['event'];
      const result = store.publish(event, frame.grant as StoredEvent['grant']);
      const accepted = result === 'accepted' || result === 'duplicate';
      send({
        t: 'ACK',
        rid: frame.rid,
        event_id: event.id,
        status: accepted ? result : 'rejected',
        reason: accepted ? null : result,
        host_ack: null
      });
      return;
    }
    case 'PAYLOAD_GET': {
      const bytes = mayRead ? store.payload(String(frame.sha256)) : null;
      if (!bytes) {
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
    case 'SUB':
      for (const wave of (frame.waves as string[]) ?? []) {
        for (const item of mayRead ? store.matching(wave) : []) {
          send({
            t: 'EV',
            sid: frame.sid,
            wave: item.event.wave,
            log_epoch: 1,
            rseq: item.rseq,
            event: item.event,
            grant: item.grant,
            receipts: []
          });
        }
        send({ t: 'EOSE', sid: frame.sid, wave, rseq: store.lastSeq });
      }
      return;
    case 'HIST': {
      const limit = Number(frame.limit);
      const items = mayRead
        ? store.matching(
            String(frame.wave),
            frame.after === null ? 0 : Number(frame.after)
          )
        : [];
      send({
        t: 'RES',
        rid: frame.rid,
        log_epoch: 1,
        items: items.slice(0, limit),
        more: items.length > limit
      });
      return;
    }
    case 'UNSUB':
      return;
    default:
      send({ t: 'ERR', rid: frame.rid ?? null, reason: 'unknown frame' });
  }
}

/** The harness's relay on loopback, keeping what is published in `dir`. */
export async function startCrpRelay(dir: string): Promise<RunningSource> {
  const store = new CrpRelayStore(dir);
  const provenance = readProvenance(dir);
  const errors: string[] = [];
  const server = http.createServer((_request, response) => {
    response.writeHead(426);
    response.end();
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) => {
    const session: Session = { socket, wallet: null, roles: [] };
    socket.on('message', (data, binary) => {
      try {
        if (binary) {
          const { header, bytes } = decodeBinary(data);
          const status = session.wallet
            ? store.putPayload(String(header.sha256), bytes)
            : 'rejected';
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
        handleFrame(store, session, JSON.parse(data.toString('utf8')) as Frame);
      } catch (error) {
        errors.push(String(error));
        socket.send(
          JSON.stringify({ t: 'ERR', rid: null, reason: 'bad frame' })
        );
      }
    });
  });
  const { port } = await listenLoopback(server);
  const url = `ws://127.0.0.1:${port}`;
  return {
    name: 'relays',
    url,
    info: {
      url,
      mode: 'local',
      provenance:
        provenance?.made_by ??
        `the harness relay, ${store.size} events in ${dir}`,
      provisional: isProvisional(provenance)
    },
    problems: () =>
      errors.length
        ? [`relays: ${errors.length} bad frames, first ${errors[0]}`]
        : [],
    stop: async () => {
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await closeServer(server);
    }
  };
}
