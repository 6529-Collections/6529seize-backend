/**
 * A client of CRP v1, the 6529 relays' client-relay protocol: JSON text
 * frames `{"t": <type>, ...}` over a WebSocket (validator repository,
 * crates/wave-relay/src/crp.rs). This client says HELLO and waits for
 * WELCOME; then it publishes events (PUB, answered by ACK), subscribes to
 * waves (SUB: EV, EOSE and RESYNC frames), pages a wave's log (HIST,
 * answered by RES) and answers the relay's CHALLENGE (AUTH, answered by
 * AUTHED). Frames it does not wait for (REV, NOTICE) are ignored.
 */

export const CRP_VERSION = 1;

/** What the client needs of a WebSocket (the WHATWG one Node 22 has). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown; reason?: string }) => void
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** Node 22's global WebSocket client. */
export const globalWebSocketFactory: WebSocketFactory = (url) => {
  const WebSocketClass = (
    globalThis as unknown as {
      WebSocket?: new (url: string) => WebSocketLike;
    }
  ).WebSocket;
  if (!WebSocketClass) {
    throw new Error('This runtime has no WebSocket client (Node 22 has one)');
  }
  return new WebSocketClass(url);
};

export type CrpAckStatus = 'accepted' | 'duplicate' | 'rejected';

export interface CrpAck {
  readonly eventId: string;
  readonly status: CrpAckStatus;
  readonly reason: string | null;
}

export interface CrpWelcome {
  readonly relayId: string;
  readonly net: string;
  /** The relay's log epoch: rseq cursors hold within one epoch. */
  readonly logEpoch: number;
}

/** An event with the proof of its grant, at its place in a wave's log. */
export interface CrpItem {
  readonly rseq: number;
  readonly event: Record<string, unknown>;
  readonly grant: Record<string, unknown>;
}

/** Where a subscription resumes in one wave's log. */
export interface CrpCursor {
  readonly wave: string;
  readonly logEpoch: number;
  readonly rseq: number;
}

export interface CrpSubscriptionHandlers {
  onEvent(wave: string, logEpoch: number, item: CrpItem): void;
  /** The replay of a wave is done; live events follow. */
  onEose(wave: string, rseq: number): void;
  /** The cursor is from another epoch or too old: page with HIST. */
  onResync(wave: string): void;
}

export interface CrpHistoryPage {
  readonly logEpoch: number;
  readonly items: CrpItem[];
  readonly more: boolean;
}

export interface CrpChallenge {
  readonly nonce: string;
  readonly expires: number;
}

/** An AUTH answer: a device key under its grant, or a service key. */
export interface CrpAuthAnswer {
  readonly grant?: Record<string, unknown>;
  readonly key?: string;
  readonly sig: string;
}

export interface CrpAuthed {
  readonly wallet: string | null;
  readonly principal: string | null;
  readonly roles: string[];
}

export class CrpError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'CrpError';
  }
}

interface Pending {
  /** The frame answering the rid: ACK, RES or AUTHED. */
  readonly resolve: (frame: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function itemOf(frame: Record<string, unknown>): CrpItem | null {
  const rseq = Number(frame.rseq);
  if (
    !Number.isSafeInteger(rseq) ||
    !frame.event ||
    typeof frame.event !== 'object' ||
    !frame.grant ||
    typeof frame.grant !== 'object'
  ) {
    return null;
  }
  return {
    rseq,
    event: frame.event as Record<string, unknown>,
    grant: frame.grant as Record<string, unknown>
  };
}

function textOf(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      'utf8'
    );
  }
  return null;
}

/** One open CRP connection to a relay. */
export class CrpConnection {
  private nextRid = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Map<number, CrpSubscriptionHandlers>();
  private closed: Error | null = null;
  private info: CrpWelcome | null = null;
  private challenge: CrpChallenge | null = null;
  private challengeWaiters: ((challenge: CrpChallenge) => void)[] = [];
  private welcome: {
    resolve: (welcome: CrpWelcome) => void;
    reject: (error: Error) => void;
  } | null = null;

  private constructor(
    private readonly socket: WebSocketLike,
    private readonly url: string
  ) {
    socket.addEventListener('message', (event) => this.onMessage(event.data));
    socket.addEventListener('close', (event) =>
      this.fail(
        new CrpError(
          `Relay ${url} closed the connection${event.reason ? `: ${event.reason}` : ''}`
        )
      )
    );
    socket.addEventListener('error', () =>
      this.fail(new CrpError(`Relay ${url}: connection error`))
    );
  }

  /**
   * Opens a connection and says HELLO as a client of network `net`. Resolves
   * on the relay's WELCOME, which must name the same network.
   */
  static open(
    url: string,
    net: string,
    {
      factory = globalWebSocketFactory,
      timeoutMs = 10_000
    }: { factory?: WebSocketFactory; timeoutMs?: number } = {}
  ): Promise<CrpConnection> {
    return new Promise((resolve, reject) => {
      let socket: WebSocketLike;
      try {
        socket = factory(url);
      } catch (error) {
        reject(error);
        return;
      }
      const connection = new CrpConnection(socket, url);
      const timer = setTimeout(() => {
        connection.welcome = null;
        connection.close();
        reject(new CrpError(`Relay ${url}: no WELCOME within ${timeoutMs} ms`));
      }, timeoutMs);
      connection.welcome = {
        resolve: (welcome) => {
          clearTimeout(timer);
          if (welcome.net !== net) {
            connection.welcome = null;
            connection.close();
            reject(
              new CrpError(
                `Relay ${url} is on network ${welcome.net}, not ${net}`
              )
            );
            return;
          }
          resolve(connection);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      };
      socket.addEventListener('open', () =>
        connection.send({ t: 'HELLO', v: CRP_VERSION, net, role: 'client' })
      );
    });
  }

  /** The relay's WELCOME. */
  get welcomeInfo(): CrpWelcome {
    if (!this.info) throw new CrpError(`Relay ${this.url}: no WELCOME yet`);
    return this.info;
  }

  /** Sends a frame with a fresh rid; resolves on the frame answering it. */
  private request(
    frame: Record<string, unknown>,
    what: string,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.closed);
    const rid = this.nextRid++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new CrpError(`Relay ${this.url}: no ${what} for rid ${rid}`));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer });
      try {
        this.send({ t: frame.t, rid, ...frame });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(error);
      }
    });
  }

  /** Publishes one event with its grant proof; resolves on its ACK. */
  async publish(
    event: unknown,
    grant: unknown,
    timeoutMs = 10_000
  ): Promise<CrpAck> {
    const frame = await this.request(
      { t: 'PUB', event, grant },
      'ACK',
      timeoutMs
    );
    const status = frame.status;
    return {
      eventId: String(frame.event_id ?? ''),
      status:
        status === 'accepted' || status === 'duplicate' ? status : 'rejected',
      reason: typeof frame.reason === 'string' ? frame.reason : null
    };
  }

  /**
   * Subscribes to `waves` (`['*']`: every wave the relay carries). Each
   * cursor replays what follows it; with `fromStart`, waves without one
   * replay from their beginning.
   */
  subscribe(
    sid: number,
    waves: string[],
    since: CrpCursor[],
    fromStart: boolean,
    handlers: CrpSubscriptionHandlers
  ): void {
    if (this.closed) throw this.closed;
    this.subscriptions.set(sid, handlers);
    this.send({
      t: 'SUB',
      sid,
      waves,
      since: since.map((c) => ({
        wave: c.wave,
        log_epoch: c.logEpoch,
        rseq: c.rseq
      })),
      from_start: fromStart
    });
  }

  unsubscribe(sid: number): void {
    this.subscriptions.delete(sid);
    if (!this.closed) this.send({ t: 'UNSUB', sid });
  }

  /** A page of one wave's log after `after` (an rseq), or its newest. */
  async history(
    wave: string,
    after: number | null,
    limit: number,
    timeoutMs = 20_000
  ): Promise<CrpHistoryPage> {
    const frame = await this.request(
      { t: 'HIST', wave, after, limit },
      'RES',
      timeoutMs
    );
    const items = Array.isArray(frame.items)
      ? (frame.items as Record<string, unknown>[])
          .map(itemOf)
          .filter((item): item is CrpItem => item !== null)
      : [];
    return {
      logEpoch: Number(frame.log_epoch ?? 0),
      items,
      more: frame.more === true
    };
  }

  /**
   * Answers the relay's CHALLENGE (the latest, or the next one) with
   * `answer`, to read members-only waves; resolves on AUTHED.
   */
  async authenticate(
    answer: (challenge: CrpChallenge, welcome: CrpWelcome) => CrpAuthAnswer,
    timeoutMs = 10_000
  ): Promise<CrpAuthed> {
    const challenge = await this.nextChallenge(timeoutMs);
    const { grant, key, sig } = answer(challenge, this.welcomeInfo);
    this.challenge = null;
    const frame = await this.request(
      {
        t: 'AUTH',
        ...(key ? { key } : {}),
        ...(grant ? { grant } : {}),
        sig
      },
      'AUTHED',
      timeoutMs
    );
    return {
      wallet: typeof frame.wallet === 'string' ? frame.wallet : null,
      principal: typeof frame.principal === 'string' ? frame.principal : null,
      roles: Array.isArray(frame.roles) ? frame.roles.map(String) : []
    };
  }

  private nextChallenge(timeoutMs: number): Promise<CrpChallenge> {
    if (this.closed) return Promise.reject(this.closed);
    if (this.challenge && this.challenge.expires > Date.now()) {
      return Promise.resolve(this.challenge);
    }
    return new Promise<CrpChallenge>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new CrpError(`Relay ${this.url}: no CHALLENGE`)),
        timeoutMs
      );
      this.challengeWaiters.push((challenge) => {
        clearTimeout(timer);
        resolve(challenge);
      });
    });
  }

  close(): void {
    this.fail(new CrpError(`Relay ${this.url}: connection closed`));
    try {
      this.socket.close(1000, 'done');
    } catch {
      // Already closed.
    }
  }

  private send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    this.welcome?.reject(error);
    this.welcome = null;
    for (const pending of Array.from(this.pending.values())) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private onMessage(data: unknown): void {
    const text = textOf(data);
    if (text === null) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    switch (frame.t) {
      case 'WELCOME':
        this.info = {
          relayId: String(frame.relay_id ?? ''),
          net: String(frame.net ?? ''),
          logEpoch: Number(frame.log_epoch ?? 0)
        };
        this.welcome?.resolve(this.info);
        this.welcome = null;
        return;
      case 'ACK':
      case 'RES':
      case 'AUTHED': {
        const pending = this.pending.get(Number(frame.rid));
        if (!pending) return;
        this.pending.delete(Number(frame.rid));
        clearTimeout(pending.timer);
        pending.resolve(frame);
        return;
      }
      case 'EV': {
        const handlers = this.subscriptions.get(Number(frame.sid));
        const item = itemOf(frame);
        if (!handlers || !item) return;
        handlers.onEvent(
          String(frame.wave ?? ''),
          Number(frame.log_epoch ?? 0),
          item
        );
        return;
      }
      case 'EOSE':
        this.subscriptions
          .get(Number(frame.sid))
          ?.onEose(String(frame.wave ?? ''), Number(frame.rseq ?? 0));
        return;
      case 'RESYNC':
        this.subscriptions
          .get(Number(frame.sid))
          ?.onResync(String(frame.wave ?? ''));
        return;
      case 'CHALLENGE': {
        this.challenge = {
          nonce: String(frame.nonce ?? ''),
          expires: Number(frame.expires ?? 0)
        };
        const waiters = this.challengeWaiters;
        this.challengeWaiters = [];
        for (const waiter of waiters) waiter(this.challenge);
        return;
      }
      case 'ERR': {
        const error = new CrpError(
          `Relay ${this.url}: ${String(frame.reason ?? 'error')}`
        );
        if (frame.rid === null || frame.rid === undefined) {
          // A frame the relay could not read ("frame too large",
          // "unreadable frame"): the session goes on; the publish it was
          // for gets no ACK and times out.
          return;
        }
        const pending = this.pending.get(Number(frame.rid));
        if (!pending) return;
        this.pending.delete(Number(frame.rid));
        clearTimeout(pending.timer);
        pending.reject(error);
        return;
      }
      default:
        return;
    }
  }
}
