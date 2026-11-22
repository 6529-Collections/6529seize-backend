import { randomBytes } from 'node:crypto';
import { verifyEd25519EventSignature } from '@/api/device-signing/device-event';
import {
  crpAuthDigest,
  CrpSocket,
  decodeCrpBinaryFrame,
  encodeCrpBinaryFrame
} from '@/e2ee/relay/e2ee-crp';
import { e2eeSha256 } from '@/e2ee/relay/e2ee-record-container';
import {
  checkE2eeRecord,
  E2eeRecordGrantProof,
  E2eeSignedRecordEvent,
  parseE2eeFamilyWave
} from '@/e2ee/relay/e2ee-record-event';

type Frame = Record<string, unknown> & { t: string };

interface StoredEvent {
  readonly rseq: number;
  readonly event: E2eeSignedRecordEvent;
  readonly grant: E2eeRecordGrantProof;
}

interface Session {
  readonly send: (data: string | Uint8Array) => void;
  nonce: string | null;
  wallet: string | null;
  roles: string[];
}

/** Payload references a record body names (`h` at any depth). */
function payloadRefs(event: E2eeSignedRecordEvent): string[] {
  if (!event.body) return [];
  const refs: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (typeof record.h === 'string') refs.push(record.h);
    Object.values(record).forEach(visit);
  };
  visit(JSON.parse(event.body));
  return refs;
}

/**
 * An in-process CRP relay with the relays' rules the orderer depends
 * on: HELLO and WELCOME (with the relay's finalized `head`), CHALLENGE and
 * AUTH by a device key under its grant, roles by wallet, PUB of family
 * events (orderer role only; `cv` LOG `seq` first wins per stream),
 * payloads by sha256, family firehose SUB and HIST for readers.
 */
export class MockCrpRelay {
  readonly relayId: string;
  private readonly events: StoredEvent[] = [];
  private readonly byId = new Map<string, StoredEvent>();
  private readonly logSeqs = new Map<string, string>();
  private readonly payloads = new Map<string, Buffer>();
  private readonly sockets = new Set<() => void>();
  private readonly sessions = new Set<Session>();
  private rseq = 0;
  /** While true, every connection attempt fails and open ones close. */
  down = false;
  /** PUBs refused before the relay starts accepting again. */
  refuseNextPubs = 0;
  /** Frames each request type has seen, for assertions. */
  readonly seen: Record<string, number> = {};

  constructor(
    readonly options: {
      readonly url: string;
      readonly net: string;
      readonly head: number;
      /** wallet -> roles (`orderer`, `site-reader`). */
      readonly roles: Readonly<Record<string, readonly string[]>>;
    }
  ) {
    this.relayId = `relay-${options.url}`;
  }

  get stored(): readonly StoredEvent[] {
    return this.events;
  }

  hasPayload(sha256: string): boolean {
    return this.payloads.has(sha256);
  }

  /** Retention: the relay drops a payload's bytes. */
  dropPayload(sha256: string) {
    this.payloads.delete(sha256);
  }

  /**
   * The relay's keepalive near a session's end: a fresh CHALLENGE to
   * every authenticated connection, which must answer it to keep going.
   */
  rechallenge() {
    for (const session of Array.from(this.sessions)) {
      if (!session.wallet) continue;
      session.nonce = `0x${randomBytes(32).toString('hex')}`;
      session.send(
        JSON.stringify({ t: 'CHALLENGE', nonce: session.nonce, expires: 0 })
      );
    }
  }

  /** The relay loses its newest `count` events (an old disk restored). */
  forgetNewest(count: number) {
    for (const lost of this.events.splice(this.events.length - count, count)) {
      this.byId.delete(lost.event.id);
      if (lost.event.kind === 11) {
        const seq = String(JSON.parse(lost.event.body ?? '{}').seq);
        this.logSeqs.delete(`${lost.event.wave}#${seq}`);
      }
    }
  }

  /** Closes every open connection (an outage). */
  disconnectAll() {
    for (const close of Array.from(this.sockets)) close();
  }

  /** A connection from a client, as a CRP socket. */
  async connect(): Promise<CrpSocket> {
    if (this.down) throw new Error(`${this.options.url} is down`);
    const messageListeners: ((data: string | Uint8Array) => void)[] = [];
    const closeListeners: ((reason: string) => void)[] = [];
    let open = true;
    const close = (reason: string) => {
      if (!open) return;
      open = false;
      this.sockets.delete(closer);
      setImmediate(() =>
        closeListeners.forEach((listener) => listener(reason))
      );
    };
    const closer = () => close('relay closed the connection');
    this.sockets.add(closer);
    const session: Session = {
      send: (data) => {
        if (!open) return;
        setImmediate(() =>
          messageListeners.forEach((listener) => listener(data))
        );
      },
      nonce: null,
      wallet: null,
      roles: []
    };
    this.sessions.add(session);
    return {
      send: (data) => {
        if (!open) throw new Error('socket closed');
        const copy = typeof data === 'string' ? data : Buffer.from(data);
        setImmediate(() => {
          if (!open) return;
          if (this.down) {
            close('relay went down');
            return;
          }
          this.receive(session, copy);
        });
      },
      close: () => close('client closed'),
      onMessage: (listener) => messageListeners.push(listener),
      onClose: (listener) => closeListeners.push(listener)
    };
  }

  private count(type: string) {
    this.seen[type] = (this.seen[type] ?? 0) + 1;
  }

  private receive(session: Session, data: string | Buffer) {
    if (typeof data !== 'string') {
      const { header, bytes } = decodeCrpBinaryFrame(data);
      this.count(header.t);
      this.putPayload(session, header as Frame, bytes);
      return;
    }
    const frame = JSON.parse(data) as Frame;
    this.count(frame.t);
    switch (frame.t) {
      case 'HELLO':
        return this.hello(session, frame);
      case 'AUTH':
        return this.auth(session, frame);
      case 'PUB':
        return this.pub(session, frame);
      case 'PAYLOAD_GET':
        return this.getPayload(session, frame);
      case 'SUB':
        return this.sub(session, frame);
      case 'HIST':
        return this.hist(session, frame);
      case 'UNSUB':
        return;
      default:
        session.send(
          JSON.stringify({
            t: 'ERR',
            rid: frame.rid ?? null,
            reason: 'unknown frame'
          })
        );
    }
  }

  private hello(session: Session, frame: Frame) {
    if (frame.net !== this.options.net) {
      session.send(
        JSON.stringify({ t: 'ERR', rid: null, reason: 'wrong net' })
      );
      return;
    }
    session.nonce = `0x${randomBytes(32).toString('hex')}`;
    session.send(
      JSON.stringify({
        t: 'WELCOME',
        v: 1,
        relay_id: this.relayId,
        log_epoch: 1,
        net: this.options.net,
        head: this.options.head
      })
    );
    session.send(
      JSON.stringify({ t: 'CHALLENGE', nonce: session.nonce, expires: 0 })
    );
  }

  private auth(session: Session, frame: Frame) {
    const grant = frame.grant as E2eeRecordGrantProof;
    const digest = crpAuthDigest({
      net: this.options.net,
      relayId: this.relayId,
      nonce: session.nonce ?? '0x',
      grantId: grant.id
    });
    const ok =
      session.nonce !== null &&
      verifyEd25519EventSignature({
        deviceKey: grant.device_key,
        eventId: digest,
        signature: String(frame.sig)
      });
    session.nonce = null;
    if (!ok) {
      session.send(
        JSON.stringify({ t: 'ERR', rid: frame.rid, reason: 'auth' })
      );
      return;
    }
    session.wallet = grant.wallet;
    session.roles = [...(this.options.roles[grant.wallet] ?? [])];
    session.send(
      JSON.stringify({
        t: 'AUTHED',
        rid: frame.rid,
        wallet: grant.wallet,
        principal: null,
        roles: session.roles
      })
    );
    // As the relays do: a fresh challenge follows every answer.
    session.nonce = `0x${randomBytes(32).toString('hex')}`;
    session.send(
      JSON.stringify({ t: 'CHALLENGE', nonce: session.nonce, expires: 0 })
    );
  }

  private ack(
    session: Session,
    rid: unknown,
    eventId: string,
    status: string,
    reason: string | null = null
  ) {
    session.send(
      JSON.stringify({
        t: 'ACK',
        rid,
        event_id: eventId,
        status,
        reason,
        host_ack: null
      })
    );
  }

  private pub(session: Session, frame: Frame) {
    const event = frame.event as E2eeSignedRecordEvent;
    const grant = frame.grant as E2eeRecordGrantProof;
    if (this.refuseNextPubs > 0) {
      this.refuseNextPubs--;
      this.ack(session, frame.rid, event.id, 'rejected', 'busy');
      return;
    }
    const family = parseE2eeFamilyWave(event.wave);
    const check = checkE2eeRecord(event, grant.device_key);
    if (!family || !check.ok || event.auth_ref !== grant.id) {
      this.ack(session, frame.rid, event.id, 'rejected', 'invalid');
      return;
    }
    if (!(this.options.roles[event.author] ?? []).includes('orderer')) {
      this.ack(session, frame.rid, event.id, 'rejected', 'not-orderer');
      return;
    }
    if (this.byId.has(event.id)) {
      this.ack(session, frame.rid, event.id, 'duplicate');
      return;
    }
    const missing = payloadRefs(event).find((ref) => !this.payloads.has(ref));
    if (missing) {
      this.ack(session, frame.rid, event.id, 'rejected', `payload ${missing}`);
      return;
    }
    if (event.kind === 11) {
      const seq = String(JSON.parse(event.body ?? '{}').seq);
      const taken = this.logSeqs.get(`${event.wave}#${seq}`);
      if (taken && taken !== event.id) {
        this.ack(session, frame.rid, event.id, 'rejected', 'seq-taken');
        return;
      }
      this.logSeqs.set(`${event.wave}#${seq}`, event.id);
    }
    const stored = { rseq: ++this.rseq, event, grant };
    this.events.push(stored);
    this.byId.set(event.id, stored);
    if (event.kind === 12) this.applyDel(event);
    this.ack(session, frame.rid, event.id, 'accepted');
  }

  /**
   * A DEL (kind 12): the named events of its wave lose their body and
   * payloads; their headers stay.
   */
  private applyDel(del: E2eeSignedRecordEvent) {
    const ids = (JSON.parse(del.body ?? '{}') as { ids?: string[] }).ids ?? [];
    for (const id of ids) {
      const target = this.byId.get(id);
      if (!target || target.event.wave !== del.wave) continue;
      for (const ref of payloadRefs(target.event)) this.payloads.delete(ref);
      const stub = { ...target, event: { ...target.event, body: null } };
      this.events[this.events.indexOf(target)] = stub;
      this.byId.set(id, stub);
    }
  }

  private putPayload(session: Session, header: Frame, bytes: Buffer) {
    const sha256 = String(header.sha256);
    if (!session.wallet) {
      this.ack(session, header.rid, sha256, 'rejected', 'auth');
      return;
    }
    if (e2eeSha256(bytes) !== sha256) {
      this.ack(session, header.rid, sha256, 'rejected', 'hash');
      return;
    }
    const known = this.payloads.has(sha256);
    this.payloads.set(sha256, bytes);
    this.ack(session, header.rid, sha256, known ? 'duplicate' : 'accepted');
  }

  private mayRead(session: Session) {
    return (
      session.roles.includes('site-reader') || session.roles.includes('orderer')
    );
  }

  private getPayload(session: Session, frame: Frame) {
    const sha256 = String(frame.sha256);
    const bytes = this.payloads.get(sha256);
    if (!this.mayRead(session) || !bytes) {
      session.send(
        JSON.stringify({ t: 'ERR', rid: frame.rid, reason: 'not found' })
      );
      return;
    }
    session.send(
      encodeCrpBinaryFrame(
        { t: 'PAYLOAD', rid: frame.rid, sha256, len: bytes.length },
        bytes
      )
    );
  }

  private matches(wave: string, name: string) {
    return wave === name || wave.startsWith(`${name}/`);
  }

  private sub(session: Session, frame: Frame) {
    const waves = (frame.waves as string[]) ?? [];
    for (const name of waves) {
      if (this.mayRead(session)) {
        for (const item of this.events.filter((e) =>
          this.matches(e.event.wave, name)
        )) {
          session.send(
            JSON.stringify({
              t: 'EV',
              sid: frame.sid,
              wave: item.event.wave,
              log_epoch: 1,
              rseq: item.rseq,
              event: item.event,
              grant: item.grant,
              receipts: []
            })
          );
        }
      }
      session.send(
        JSON.stringify({
          t: 'EOSE',
          sid: frame.sid,
          wave: name,
          rseq: this.rseq
        })
      );
    }
  }

  private hist(session: Session, frame: Frame) {
    const limit = Number(frame.limit);
    const matching = this.mayRead(session)
      ? this.events.filter((e) =>
          this.matches(e.event.wave, String(frame.wave))
        )
      : [];
    // Without `after`, the newest page.
    const items =
      frame.after === null || frame.after === undefined
        ? matching.slice(-limit)
        : matching
            .filter((e) => e.rseq > Number(frame.after))
            .slice(0, limit + 1);
    session.send(
      JSON.stringify({
        t: 'RES',
        rid: frame.rid,
        log_epoch: 1,
        items: items.slice(0, limit),
        more: items.length > limit
      })
    );
  }
}
