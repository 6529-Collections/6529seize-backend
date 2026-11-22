import { CrpConnection, CrpError, WebSocketLike } from './crp-client';

type Listener = (event: { data?: unknown; reason?: string }) => void;

/** A WebSocket double: records what was sent, plays the relay's frames. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  closedWith: number | undefined;
  private readonly listeners: Record<string, Listener[]> = {};

  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number): void {
    this.closedWith = code;
  }

  emit(type: string, event: { data?: unknown; reason?: string } = {}) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }

  relay(frame: Record<string, unknown>) {
    this.emit('message', { data: JSON.stringify(frame) });
  }
}

const NET = '6529-chain-1';

async function opened(socket = new FakeSocket()) {
  const connecting = CrpConnection.open('wss://relay.example', NET, {
    factory: () => socket,
    timeoutMs: 1_000
  });
  socket.emit('open');
  expect(socket.sent[0]).toEqual({
    t: 'HELLO',
    v: 1,
    net: NET,
    role: 'client'
  });
  socket.relay({ t: 'WELCOME', v: 1, relay_id: 'r-1', log_epoch: 1, net: NET });
  return { connection: await connecting, socket };
}

describe('CrpConnection', () => {
  it('says HELLO as a client and opens on the WELCOME of its network', async () => {
    const { connection } = await opened();
    expect(connection).toBeInstanceOf(CrpConnection);
  });

  it('refuses a relay on another network', async () => {
    const socket = new FakeSocket();
    const connecting = CrpConnection.open('wss://relay.example', NET, {
      factory: () => socket,
      timeoutMs: 1_000
    });
    socket.emit('open');
    socket.relay({
      t: 'WELCOME',
      v: 1,
      relay_id: 'r',
      log_epoch: 1,
      net: 'other'
    });
    await expect(connecting).rejects.toThrow('is on network other');
    expect(socket.closedWith).toBe(1000);
  });

  it('fails when the relay closes before its WELCOME', async () => {
    const socket = new FakeSocket();
    const connecting = CrpConnection.open('wss://relay.example', NET, {
      factory: () => socket,
      timeoutMs: 1_000
    });
    socket.emit('close', { reason: 'full' });
    await expect(connecting).rejects.toThrow('closed the connection: full');
  });

  it('gives up without a WELCOME', async () => {
    const socket = new FakeSocket();
    await expect(
      CrpConnection.open('wss://relay.example', NET, {
        factory: () => socket,
        timeoutMs: 10
      })
    ).rejects.toThrow('no WELCOME');
  });

  it('publishes with a fresh rid and resolves on the ACK of that rid', async () => {
    const { connection, socket } = await opened();
    const first = connection.publish({ id: 'e1' }, { id: 'g1' });
    const second = connection.publish({ id: 'e2' }, { id: 'g1' });
    expect(socket.sent.slice(1)).toEqual([
      { t: 'PUB', rid: 1, event: { id: 'e1' }, grant: { id: 'g1' } },
      { t: 'PUB', rid: 2, event: { id: 'e2' }, grant: { id: 'g1' } }
    ]);
    // Out of order, and frames the client does not wait for in between.
    socket.relay({ t: 'NOTICE', msg: 'hi' });
    socket.relay({
      t: 'ACK',
      rid: 2,
      event_id: 'e2',
      status: 'duplicate',
      reason: null
    });
    socket.relay({
      t: 'ACK',
      rid: 1,
      event_id: 'e1',
      status: 'rejected',
      reason: 'the grant expired'
    });
    await expect(second).resolves.toEqual({
      eventId: 'e2',
      status: 'duplicate',
      reason: null
    });
    await expect(first).resolves.toEqual({
      eventId: 'e1',
      status: 'rejected',
      reason: 'the grant expired'
    });
  });

  it('rejects a publish the relay answers with ERR', async () => {
    const { connection, socket } = await opened();
    const publish = connection.publish({ id: 'e1' }, { id: 'g1' });
    socket.relay({ t: 'ERR', rid: 1, reason: 'bad frame' });
    await expect(publish).rejects.toThrow('bad frame');
  });

  it('fails every waiting publish when the connection ends', async () => {
    const { connection, socket } = await opened();
    const publish = connection.publish({ id: 'e1' }, { id: 'g1' });
    socket.relay({ t: 'ERR', rid: null, reason: 'going away' });
    await expect(publish).rejects.toBeInstanceOf(CrpError);
    await expect(connection.publish({ id: 'e2' }, {})).rejects.toThrow(
      'going away'
    );
  });

  it('gives up on a publish without an ACK', async () => {
    const { connection } = await opened();
    await expect(connection.publish({ id: 'e1' }, {}, 10)).rejects.toThrow(
      'no ACK for rid 1'
    );
  });

  it('ignores frames it cannot read', async () => {
    const { connection, socket } = await opened();
    const publish = connection.publish({ id: 'e1' }, {});
    socket.emit('message', { data: 'not json' });
    socket.emit('message', { data: 42 });
    socket.relay({ t: 'ACK', rid: 99, event_id: 'x', status: 'accepted' });
    socket.relay({ t: 'ACK', rid: 1, event_id: 'e1', status: 'accepted' });
    await expect(publish).resolves.toMatchObject({ status: 'accepted' });
  });
});
