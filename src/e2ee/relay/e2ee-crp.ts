import { ethers } from 'ethers';
import {
  E2eeRecordGrantProof,
  E2eeSignedRecordEvent
} from '@/e2ee/relay/e2ee-record-event';

/**
 * A CRP v1 client (the relays' client protocol: JSON text frames over a
 * WebSocket, `{"t": <type>, ...}`), with the relays' additions the
 * orderer needs: CHALLENGE and AUTH, family waves, and binary payload frames
 * (`u32be header length | header JSON | bytes`).
 *
 * The socket is injected, so tests drive it in process and production uses
 * Node's WebSocket (Node 22).
 */
export const CRP_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 15_000;
/** A relay session reads and writes for an hour. */
export const CRP_SESSION_MS = 60 * 60 * 1000;
/**
 * A CHALLENGE that arrives this close to the session's end is answered at
 * once. The relay sends one within its challenge lifetime (5 minutes) of
 * the end; the fresh challenge that follows every AUTH comes an hour
 * early and waits.
 */
const REAUTH_WINDOW_MS = 10 * 60 * 1000;

/** One event with the grant proof its `auth_ref` names. */
export interface CrpItem {
  readonly rseq: number;
  readonly event: E2eeSignedRecordEvent;
  readonly grant: E2eeRecordGrantProof;
}

export type CrpAckStatus = 'accepted' | 'duplicate' | 'rejected';

export interface CrpAck {
  readonly eventId: string;
  readonly status: CrpAckStatus;
  readonly reason: string | null;
}

export interface CrpWelcome {
  readonly relayId: string;
  readonly logEpoch: number;
  readonly net: string;
  /** The relay's finalized chain height, when it says (an anchor source). */
  readonly head: number | null;
}

export interface CrpAuthed {
  readonly wallet: string;
  readonly principal: string | null;
  readonly roles: readonly string[];
}

export interface CrpSocket {
  send(data: string | Uint8Array): void;
  close(): void;
  onMessage(listener: (data: string | Uint8Array) => void): void;
  onClose(listener: (reason: string) => void): void;
}

export class CrpError extends Error {
  constructor(
    message: string,
    readonly code: 'timeout' | 'closed' | 'relay' | 'protocol'
  ) {
    super(message);
    this.name = 'CrpError';
    Object.setPrototypeOf(this, CrpError.prototype);
  }
}

type Frame = Record<string, unknown> & { readonly t: string };

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  /** Restarts the time limit (each frame of a long answer). */
  readonly touch: () => void;
}

/** How a connection proves its device key, kept to answer re-challenges. */
export interface CrpAuthInput {
  readonly grant: E2eeRecordGrantProof;
  readonly sign: (digest: string) => string;
  readonly net: string;
}

/** The binary frame layout of payload uploads and downloads. */
export function encodeCrpBinaryFrame(
  header: Record<string, unknown>,
  bytes: Uint8Array
): Uint8Array {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(headerBytes.length, 0);
  return Buffer.concat([prefix, headerBytes, Buffer.from(bytes)]);
}

export function decodeCrpBinaryFrame(data: Uint8Array): {
  readonly header: Frame;
  readonly bytes: Buffer;
} {
  const buffer = Buffer.from(data);
  if (buffer.length < 4) throw new CrpError('Short binary frame', 'protocol');
  const length = buffer.readUInt32BE(0);
  if (4 + length > buffer.length) {
    throw new CrpError('Binary header overruns the frame', 'protocol');
  }
  const header = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
  if (typeof header?.t !== 'string') {
    throw new CrpError('Binary header has no type', 'protocol');
  }
  return { header, bytes: Buffer.from(buffer.subarray(4 + length)) };
}

/** P28's tagged hash: keccak256(abi.encode(keccak256(name), fields...)). */
export function crpAuthDigest(input: {
  readonly net: string;
  readonly relayId: string;
  readonly nonce: string;
  readonly grantId: string;
}): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [
        ethers.keccak256(ethers.toUtf8Bytes('6529.RelayAuth.v1')),
        ethers.keccak256(ethers.toUtf8Bytes(input.net)),
        ethers.keccak256(ethers.toUtf8Bytes(input.relayId)),
        input.nonce,
        input.grantId
      ]
    )
  );
}

/** One live subscription's replay, read to its end (EOSE per wave). */
export interface CrpReplay {
  readonly items: CrpItem[];
  readonly resync: string[];
}

export class CrpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Map<
    number,
    {
      readonly waves: Set<string>;
      readonly done: Set<string>;
      readonly replay: CrpReplay;
      readonly settle: (error?: Error) => void;
      readonly touch: () => void;
    }
  >();
  private welcomeWait: Pending | null = null;
  private challenge: { nonce: string; expires: number | null } | null = null;
  private challengeWait: Pending | null = null;
  private closed: string | null = null;
  private welcome: CrpWelcome | null = null;
  private authInput: CrpAuthInput | null = null;
  private sessionUntil: number | null = null;
  private reauthing: Promise<void> | null = null;
  /** When the connection was opened (its WELCOME's age). */
  readonly openedAt: number;

  constructor(
    private readonly socket: CrpSocket,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly now: () => number = Date.now
  ) {
    this.openedAt = now();
    socket.onMessage((data) => this.receive(data));
    socket.onClose((reason) => this.fail(reason));
  }

  /** When the relay session ends unless a CHALLENGE is answered. */
  get sessionEndsAt(): number | null {
    return this.sessionUntil;
  }

  get relayId(): string | null {
    return this.welcome?.relayId ?? null;
  }

  get isOpen(): boolean {
    return this.closed === null;
  }

  private wait<T>(register: (pending: Pending) => void): Promise<T> {
    if (this.closed !== null) {
      return Promise.reject(new CrpError(this.closed, 'closed'));
    }
    return new Promise<T>((resolve, reject) => {
      const expire = () =>
        reject(new CrpError('Relay did not answer in time', 'timeout'));
      let timer = setTimeout(expire, this.timeoutMs);
      register({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        touch: () => {
          clearTimeout(timer);
          timer = setTimeout(expire, this.timeoutMs);
        }
      });
    });
  }

  private request<T>(frame: Omit<Frame, 'rid'>): Promise<T> {
    const rid = this.nextId++;
    const answer = this.wait<T>((pending) => this.pending.set(rid, pending));
    this.socket.send(JSON.stringify({ ...frame, rid }));
    return answer.finally(() => this.pending.delete(rid));
  }

  /** HELLO, then the relay's WELCOME. */
  async hello(net: string): Promise<CrpWelcome> {
    const answer = this.wait<CrpWelcome>((pending) => {
      this.welcomeWait = pending;
    });
    this.socket.send(
      JSON.stringify({ t: 'HELLO', v: CRP_VERSION, net, role: 'client' })
    );
    const welcome = await answer;
    if (welcome.net !== net) {
      throw new CrpError(`Relay is on ${welcome.net}, not ${net}`, 'protocol');
    }
    return welcome;
  }

  /**
   * Answers the relay's CHALLENGE with a device key under its grant. The
   * connection keeps the key's signer and answers the CHALLENGE the relay
   * sends before the session's hour runs out, so a long-lived connection
   * keeps its session (and with it the orderer's role).
   */
  async auth(input: CrpAuthInput): Promise<CrpAuthed> {
    if (!this.welcome) throw new CrpError('AUTH before WELCOME', 'protocol');
    const challenge =
      this.challenge ??
      (await this.wait<{ nonce: string; expires: number | null }>((pending) => {
        this.challengeWait = pending;
      }));
    this.challenge = null;
    const startedAt = this.now();
    const digest = crpAuthDigest({
      net: input.net,
      relayId: this.welcome.relayId,
      nonce: challenge.nonce,
      grantId: input.grant.id
    });
    const authed = await this.request<Frame>({
      t: 'AUTH',
      grant: input.grant,
      sig: input.sign(digest)
    });
    this.authInput = input;
    this.sessionUntil = startedAt + CRP_SESSION_MS;
    return {
      wallet: String(authed.wallet ?? ''),
      principal: (authed.principal as string | null) ?? null,
      roles: Array.isArray(authed.roles) ? authed.roles.map(String) : []
    };
  }

  /** Answers a held CHALLENGE when the session ends soon. */
  private maybeReauth() {
    if (
      !this.authInput ||
      !this.challenge ||
      this.reauthing !== null ||
      this.closed !== null ||
      this.sessionUntil === null ||
      this.sessionUntil - this.now() > REAUTH_WINDOW_MS
    ) {
      return;
    }
    const input = this.authInput;
    this.reauthing = this.auth(input)
      .then(() => undefined)
      .catch((error: Error) => {
        // The session runs out; the pool reconnects on the next failure.
        this.fail(`re-authentication failed (${error.message})`);
        this.socket.close();
      })
      .finally(() => {
        this.reauthing = null;
      });
  }

  async publish(
    event: E2eeSignedRecordEvent,
    grant: E2eeRecordGrantProof
  ): Promise<CrpAck> {
    const ack = await this.request<Frame>({ t: 'PUB', event, grant });
    return toAck(ack);
  }

  /** Uploads bytes named by their sha256 (0x hex). */
  async putPayload(sha256: string, bytes: Uint8Array): Promise<CrpAck> {
    const rid = this.nextId++;
    const answer = this.wait<Frame>((pending) =>
      this.pending.set(rid, pending)
    );
    this.socket.send(
      encodeCrpBinaryFrame(
        { t: 'PAYLOAD_PUT', rid, sha256, len: bytes.length },
        bytes
      )
    );
    try {
      return toAck(await answer);
    } finally {
      this.pending.delete(rid);
    }
  }

  async getPayload(sha256: string): Promise<Buffer> {
    const rid = this.nextId++;
    const answer = this.wait<unknown>((pending) =>
      this.pending.set(rid, pending)
    );
    this.socket.send(JSON.stringify({ t: 'PAYLOAD_GET', rid, sha256 }));
    try {
      const bytes = await answer;
      if (!Buffer.isBuffer(bytes)) {
        throw new CrpError(`No payload ${sha256}`, 'relay');
      }
      return bytes;
    } finally {
      this.pending.delete(rid);
    }
  }

  /** One page of a wave's log after `after` (an rseq). */
  async history(
    wave: string,
    after: number | null,
    limit: number
  ): Promise<{ readonly items: CrpItem[]; readonly more: boolean }> {
    const res = await this.request<Frame>({ t: 'HIST', wave, after, limit });
    return {
      items: (res.items as CrpItem[]) ?? [],
      more: res.more === true
    };
  }

  /**
   * Replays `waves` from their start (or a family's firehose) until the
   * relay says EOSE for each, then unsubscribes.
   */
  async replay(waves: readonly string[]): Promise<CrpReplay> {
    const sid = this.nextId++;
    const replay: CrpReplay = { items: [], resync: [] };
    const finished = this.wait<void>((pending) => {
      this.subscriptions.set(sid, {
        waves: new Set(waves),
        done: new Set(),
        replay,
        settle: (error) =>
          error ? pending.reject(error) : pending.resolve(undefined),
        touch: pending.touch
      });
    });
    this.socket.send(
      JSON.stringify({ t: 'SUB', sid, waves, since: [], from_start: true })
    );
    try {
      await finished;
    } finally {
      this.subscriptions.delete(sid);
      if (this.closed === null) {
        this.socket.send(JSON.stringify({ t: 'UNSUB', sid }));
      }
    }
    return replay;
  }

  close() {
    this.socket.close();
    this.fail('closed by client');
  }

  private fail(reason: string) {
    if (this.closed !== null) return;
    this.closed = reason;
    const error = new CrpError(`Relay connection closed: ${reason}`, 'closed');
    for (const pending of Array.from(this.pending.values())) {
      pending.reject(error);
    }
    this.pending.clear();
    this.welcomeWait?.reject(error);
    this.challengeWait?.reject(error);
    for (const sub of Array.from(this.subscriptions.values())) {
      sub.settle(error);
    }
  }

  private receive(data: string | Uint8Array) {
    try {
      if (typeof data === 'string') {
        this.onFrame(JSON.parse(data) as Frame);
      } else {
        this.onBinary(data);
      }
    } catch (error) {
      this.fail(`unreadable frame (${(error as Error).message})`);
      this.socket.close();
    }
  }

  private onBinary(data: Uint8Array) {
    const { header, bytes } = decodeCrpBinaryFrame(data);
    if (header.t !== 'PAYLOAD') return;
    this.pending.get(Number(header.rid))?.resolve(bytes);
  }

  private onFrame(frame: Frame) {
    switch (frame.t) {
      case 'WELCOME':
        this.welcome = {
          relayId: String(frame.relay_id),
          logEpoch: Number(frame.log_epoch),
          net: String(frame.net),
          head: typeof frame.head === 'number' ? frame.head : null
        };
        this.welcomeWait?.resolve(this.welcome);
        this.welcomeWait = null;
        return;
      case 'CHALLENGE': {
        const challenge = {
          nonce: String(frame.nonce),
          expires: typeof frame.expires === 'number' ? frame.expires : null
        };
        if (this.challengeWait) {
          this.challengeWait.resolve(challenge);
          this.challengeWait = null;
        } else {
          this.challenge = challenge;
          this.maybeReauth();
        }
        return;
      }
      case 'EV':
        this.onEvent(frame);
        return;
      case 'EOSE':
      case 'RESYNC':
        this.onReplayEnd(frame);
        return;
      case 'ERR':
        this.onError(frame);
        return;
      default:
        this.onAnswer(frame);
    }
  }

  private onAnswer(frame: Frame) {
    const rid = Number(frame.rid);
    const pending = this.pending.get(rid);
    if (pending) pending.resolve(frame);
  }

  private onError(frame: Frame) {
    const error = new CrpError(String(frame.reason ?? 'relay error'), 'relay');
    if (frame.rid === null || frame.rid === undefined) {
      this.fail(`relay error: ${error.message}`);
      return;
    }
    this.pending.get(Number(frame.rid))?.reject(error);
  }

  private onEvent(frame: Frame) {
    const sub = this.subscriptions.get(Number(frame.sid));
    if (!sub) return;
    // A replay's time limit runs from its latest frame, not its start.
    sub.touch();
    sub.replay.items.push({
      rseq: Number(frame.rseq),
      event: frame.event as E2eeSignedRecordEvent,
      grant: frame.grant as E2eeRecordGrantProof
    });
  }

  private onReplayEnd(frame: Frame) {
    const sub = this.subscriptions.get(Number(frame.sid));
    if (!sub) return;
    const wave = String(frame.wave);
    sub.touch();
    if (frame.t === 'RESYNC') sub.replay.resync.push(wave);
    sub.done.add(wave);
    if (Array.from(sub.waves).every((name) => sub.done.has(name))) {
      sub.settle();
    }
  }
}

function toAck(frame: Frame): CrpAck {
  const status = frame.status;
  if (
    status !== 'accepted' &&
    status !== 'duplicate' &&
    status !== 'rejected'
  ) {
    throw new CrpError(`Unexpected answer ${frame.t}`, 'protocol');
  }
  return {
    eventId: String(frame.event_id ?? ''),
    status,
    reason: (frame.reason as string | null) ?? null
  };
}

interface NodeWebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

type NodeWebSocketConstructor = new (url: string) => NodeWebSocketLike;

/** Opens a CRP socket with Node's built-in WebSocket (Node 22 and later). */
export function openNodeCrpSocket(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<CrpSocket> {
  const WebSocketImpl = (globalThis as { WebSocket?: unknown }).WebSocket as
    | NodeWebSocketConstructor
    | undefined;
  if (!WebSocketImpl) {
    return Promise.reject(
      new CrpError('This Node has no built-in WebSocket', 'protocol')
    );
  }
  const ws = new WebSocketImpl(url);
  ws.binaryType = 'arraybuffer';
  const messageListeners: ((data: string | Uint8Array) => void)[] = [];
  const closeListeners: ((reason: string) => void)[] = [];
  ws.addEventListener('message', (event) => {
    const data = (event as { data: unknown }).data;
    const value =
      typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer);
    for (const listener of messageListeners) listener(value);
  });
  ws.addEventListener('close', (event) => {
    const reason = String((event as { reason?: unknown }).reason ?? 'closed');
    for (const listener of closeListeners) listener(reason || 'closed');
  });
  const socket: CrpSocket = {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onMessage: (listener) => messageListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener)
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new CrpError(`Could not reach ${url}`, 'timeout'));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new CrpError(`Could not reach ${url}`, 'closed'));
    });
  });
}
