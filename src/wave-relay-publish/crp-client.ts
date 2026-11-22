/**
 * A client of CRP v1, the 6529 relays' client-relay protocol: JSON text
 * frames `{"t": <type>, ...}` over a WebSocket (validator repository,
 * crates/wave-relay/src/crp.rs). This client says HELLO, waits for WELCOME
 * and publishes events with PUB, each answered by an ACK with its rid. It
 * reads nothing else: frames it does not wait for (REV, NOTICE, CHALLENGE)
 * are ignored.
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
}

export class CrpError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'CrpError';
  }
}

interface Pending {
  readonly resolve: (ack: CrpAck) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
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
  private closed: Error | null = null;
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

  /** Publishes one event with its grant proof; resolves on its ACK. */
  publish(event: unknown, grant: unknown, timeoutMs = 10_000): Promise<CrpAck> {
    if (this.closed) return Promise.reject(this.closed);
    const rid = this.nextRid++;
    return new Promise<CrpAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new CrpError(`Relay ${this.url}: no ACK for rid ${rid}`));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer });
      try {
        this.send({ t: 'PUB', rid, event, grant });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(error);
      }
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
        this.welcome?.resolve({
          relayId: String(frame.relay_id ?? ''),
          net: String(frame.net ?? '')
        });
        this.welcome = null;
        return;
      case 'ACK': {
        const pending = this.pending.get(Number(frame.rid));
        if (!pending) return;
        this.pending.delete(Number(frame.rid));
        clearTimeout(pending.timer);
        const status = frame.status;
        pending.resolve({
          eventId: String(frame.event_id ?? ''),
          status:
            status === 'accepted' || status === 'duplicate'
              ? status
              : 'rejected',
          reason: typeof frame.reason === 'string' ? frame.reason : null
        });
        return;
      }
      case 'ERR': {
        const error = new CrpError(
          `Relay ${this.url}: ${String(frame.reason ?? 'error')}`
        );
        if (frame.rid === null || frame.rid === undefined) {
          // A connection-level error: the relay ends the session.
          this.fail(error);
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
