import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  bareHash,
  decodeBinary,
  EVENTS_FILE,
  Frame,
  logOf,
  PAYLOADS_DIR,
  READS_FILE,
  RELAY_FILE,
  ROLES_FILE,
  sha256Hex,
  StoredEvent,
  WsSocket
} from '@/rebuild/sources/crp-relay';
import {
  closeServer,
  listenLoopback,
  RunningSource,
  writeProvenance
} from '@/rebuild/sources/running-source';

interface WsServer {
  on(event: 'connection', listener: (socket: WsSocket) => void): void;
  close(callback?: () => void): void;
}
interface WsClient extends WsSocket {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: Buffer, binary: boolean) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}
const ws = require('ws') as {
  WebSocketServer: new (options: { server: http.Server }) => WsServer;
} & (new (url: string) => WsClient);

interface Seen {
  rseq: number | null;
  readonly event: StoredEvent['event'];
  readonly grant: StoredEvent['grant'];
  extra: Record<string, unknown>;
  readonly recordedAt: number;
}

/** A frame's fields other than `known`: what the relay sent beside the event. */
function others(
  frame: Record<string, unknown>,
  known: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(frame).filter(([key]) => !known.includes(key))
  );
}

/** What a recorded run saw of the relay, written out when it stops. */
class RelayRecording {
  private readonly events = new Map<string, Seen>();
  private readonly roles: Record<string, string[]> = {};
  private readonly reads = new Set<string>();
  private head: number | null = null;

  constructor(private readonly dir: string) {
    for (const file of [EVENTS_FILE, READS_FILE, ROLES_FILE, RELAY_FILE]) {
      fs.rmSync(path.join(dir, file), { force: true });
    }
    fs.rmSync(path.join(dir, PAYLOADS_DIR), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, PAYLOADS_DIR), { recursive: true });
  }

  event(
    event: StoredEvent['event'],
    grant: StoredEvent['grant'],
    rseq: number | null,
    extra: Record<string, unknown> = {}
  ): void {
    const seen = this.events.get(event.id);
    if (!seen) {
      this.events.set(event.id, {
        rseq,
        event,
        grant,
        extra,
        recordedAt: Date.now()
      });
    } else if (seen.rseq === null && rseq !== null) {
      seen.rseq = rseq;
      seen.extra = extra;
    }
  }

  payload(hash: string, bytes: Buffer): void {
    if (sha256Hex(bytes) !== bareHash(hash)) return;
    fs.writeFileSync(path.join(this.dir, PAYLOADS_DIR, bareHash(hash)), bytes);
  }

  read(wave: string): void {
    this.reads.add(wave);
  }

  authed(wallet: string, roles: string[]): void {
    this.roles[wallet.toLowerCase()] = roles;
  }

  welcome(head: number): void {
    this.head = head;
  }

  /**
   * Writes the recording, events in the order the run first saw them, each
   * with its log's rseq from the relay. One the run published but never
   * read back takes the next rseq of its log.
   */
  save(): number {
    const all = Array.from(this.events.values());
    const heads = new Map<string, number>();
    all.forEach((seen) => {
      const log = logOf(seen.event.wave);
      heads.set(log, Math.max(heads.get(log) ?? 0, seen.rseq ?? 0));
    });
    const next = (wave: string) => {
      const rseq = (heads.get(logOf(wave)) ?? 0) + 1;
      heads.set(logOf(wave), rseq);
      return rseq;
    };
    const ordered = all.map(
      (seen): StoredEvent => ({
        rseq: seen.rseq ?? next(seen.event.wave),
        event: seen.event,
        grant: seen.grant,
        ...(Object.keys(seen.extra).length ? { extra: seen.extra } : {}),
        recorded_at: seen.recordedAt
      })
    );
    fs.writeFileSync(
      path.join(this.dir, EVENTS_FILE),
      ordered.map((stored) => `${JSON.stringify(stored)}\n`).join('')
    );
    fs.writeFileSync(
      path.join(this.dir, READS_FILE),
      `${JSON.stringify(Array.from(this.reads).sort(), null, 2)}\n`
    );
    fs.writeFileSync(
      path.join(this.dir, ROLES_FILE),
      `${JSON.stringify(this.roles, null, 2)}\n`
    );
    if (this.head !== null) {
      fs.writeFileSync(
        path.join(this.dir, RELAY_FILE),
        `${JSON.stringify({ head: this.head })}\n`
      );
    }
    return ordered.length;
  }
}

/** Fields of an EV frame and a HIST item the replay rebuilds itself. */
const EV_FIELDS = [
  't',
  'sid',
  'wave',
  'log_epoch',
  'rseq',
  'event',
  'grant',
  'recorded_at'
];
const ITEM_FIELDS = ['rseq', 'event', 'grant', 'recorded_at'];

/** Notes what one frame from the client tells the recording. */
function fromClient(
  recording: RelayRecording,
  pending: Map<unknown, Pick<Seen, 'event' | 'grant'>>,
  data: Buffer,
  binary: boolean
): void {
  if (binary) {
    const { header, bytes } = decodeBinary(data);
    recording.payload(String(header.sha256), bytes);
    return;
  }
  const frame = JSON.parse(data.toString('utf8')) as Frame;
  if (frame.t === 'PUB') {
    pending.set(frame.rid, {
      event: frame.event as StoredEvent['event'],
      grant: (frame.grant ?? {}) as StoredEvent['grant']
    });
  } else if (frame.t === 'SUB') {
    for (const wave of (frame.waves as string[]) ?? []) recording.read(wave);
  } else if (frame.t === 'HIST') {
    recording.read(String(frame.wave));
  }
}

/** Notes what one frame from the relay tells the recording. */
function fromRelay(
  recording: RelayRecording,
  pending: Map<unknown, Pick<Seen, 'event' | 'grant'>>,
  data: Buffer,
  binary: boolean
): void {
  if (binary) {
    const { header, bytes } = decodeBinary(data);
    if (header.t === 'PAYLOAD') recording.payload(String(header.sha256), bytes);
    return;
  }
  const frame = JSON.parse(data.toString('utf8')) as Frame;
  switch (frame.t) {
    case 'WELCOME':
      recording.welcome(Number(frame.head));
      return;
    case 'AUTHED':
      recording.authed(String(frame.wallet), (frame.roles as string[]) ?? []);
      return;
    case 'ACK': {
      const published = pending.get(frame.rid);
      pending.delete(frame.rid);
      if (
        published &&
        (frame.status === 'accepted' || frame.status === 'duplicate')
      ) {
        recording.event(published.event, published.grant, null);
      }
      return;
    }
    case 'EV':
      recording.event(
        frame.event as StoredEvent['event'],
        (frame.grant ?? {}) as StoredEvent['grant'],
        Number(frame.rseq),
        others(frame, EV_FIELDS)
      );
      return;
    case 'RES':
      for (const item of (frame.items as Record<string, unknown>[]) ?? []) {
        recording.event(
          item.event as StoredEvent['event'],
          (item.grant ?? {}) as StoredEvent['grant'],
          Number(item.rseq),
          others(item, ITEM_FIELDS)
        );
      }
      return;
    default:
      return;
  }
}

/**
 * A CRP v1 proxy on loopback to the relay at `upstream`, saving into `dir`
 * what the run sees: the events it reads or publishes (with the relay's
 * order), payloads, roles, the reported head, and the waves it reads. The
 * recording is written when the source stops; `replay:<dir>` serves it.
 * Recording reaches a relay, so it is never a final source itself.
 */
export async function startCrpRelayRecord(options: {
  dir: string;
  upstream: string;
  /** How the report and PROVENANCE.json name the upstream. */
  upstreamLabel: string;
}): Promise<RunningSource> {
  fs.mkdirSync(options.dir, { recursive: true });
  const recording = new RelayRecording(options.dir);
  const errors: string[] = [];
  const upstreams = new Set<WsClient>();
  const server = http.createServer((_request, response) => {
    response.writeHead(426);
    response.end();
  });
  const sockets = new ws.WebSocketServer({ server });
  sockets.on('connection', (client) => {
    const pending = new Map<unknown, Pick<Seen, 'event' | 'grant'>>();
    const upstream = new ws(options.upstream);
    upstreams.add(upstream);
    // Frames the run sends before the relay connection opens, as they came.
    const queued: (string | Buffer)[] = [];
    let open = false;
    const note = (side: string, fn: () => void) => {
      try {
        fn();
      } catch (error) {
        errors.push(`${side}: ${String(error)}`);
      }
    };
    upstream.on('open', () => {
      open = true;
      queued.splice(0).forEach((data) => upstream.send(data));
    });
    upstream.on('message', (data, binary) => {
      note('from the relay', () => fromRelay(recording, pending, data, binary));
      client.send(binary ? data : data.toString('utf8'));
    });
    upstream.on('error', (error) => {
      errors.push(`the relay: ${error.message}`);
      client.close();
    });
    upstream.on('close', () => {
      upstreams.delete(upstream);
      client.close();
    });
    client.on('message', (data, binary) => {
      note('from the run', () => fromClient(recording, pending, data, binary));
      // Text stays text: ws sends a Buffer as a binary frame.
      const out = binary ? data : data.toString('utf8');
      if (open) upstream.send(out);
      else queued.push(out);
    });
    client.on('close', () => upstream.close());
  });
  const { port } = await listenLoopback(server);
  const url = `ws://127.0.0.1:${port}`;
  return {
    name: 'relays',
    url,
    info: {
      url,
      mode: 'record',
      provenance: `recording ${options.upstreamLabel} into ${options.dir}`,
      provisional: true
    },
    problems: () =>
      errors.length
        ? [`relays: ${errors.length} recording errors, first ${errors[0]}`]
        : [],
    stop: async () => {
      Array.from(upstreams).forEach((upstream) => upstream.close());
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await closeServer(server);
      recording.save();
      // Written fresh: a label of how this recording was made, never one an
      // earlier recording left (the checks, not the label, decide final).
      writeProvenance(options.dir, {
        made_by: `record of ${options.upstreamLabel}`,
        recorded_at: new Date().toISOString()
      });
    }
  };
}
