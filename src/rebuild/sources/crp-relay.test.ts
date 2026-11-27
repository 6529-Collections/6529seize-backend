import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  byCodeUnit,
  canonicalJson,
  CrpRelayStore,
  payloadRefs,
  startCrpRelay
} from '@/rebuild/sources/crp-relay';
import { RelayRules } from '@/rebuild/sources/relay-rules';

/** The test's reader: 0xab with both roles. */
const RULES = new RelayRules(
  new Set(),
  new Map([
    ['0xab', { roles: ['orderer', 'site-reader'] as const, principal: null }]
  ])
);

const WebSocketClient = require('ws') as new (url: string) => {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: Buffer, binary: boolean) => void): void;
  send(data: string | Buffer): void;
  close(): void;
};

const hashOf = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

function event(id: string, wave: string, extra: Record<string, unknown> = {}) {
  return { id, wave, kind: 9, body: null, ...extra };
}

describe('harness relay', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-relay-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('orders strings by UTF-16 code unit, as a sort with no compare function does', () => {
    const words = ['b', 'B', '_', '0', 'a', 'é', '\u{1f600}', '￿'];
    // A surrogate pair (U+1F600) sorts before U+FFFF: code units, not points.
    expect([...words, 'ab', 'a'].sort(byCodeUnit)).toEqual([
      '0',
      'B',
      '_',
      'a',
      'a',
      'ab',
      'b',
      'é',
      '\u{1f600}',
      '￿'
    ]);
    expect(canonicalJson({ b: 1, B: { z: 1, _: 2 }, a: [3] })).toBe(
      '{"B":{"_":2,"z":1},"a":[3],"b":1}'
    );
  });

  it('finds payload references at any depth', () => {
    expect(payloadRefs('{"h":"0xaa","x":[{"h":"bb"}]}')).toEqual([
      '0xaa',
      'bb'
    ]);
    expect(payloadRefs('not json')).toEqual([]);
    expect(payloadRefs(null)).toEqual([]);
  });

  it('keeps one copy per id, takes a LOG seq once, and wants payloads first', () => {
    const store = new CrpRelayStore(dir);
    expect(store.publish(event('e1', 'dr/1'), {}).result).toBe('accepted');
    expect(store.publish(event('e1', 'dr/1'), {}).result).toBe('duplicate');
    const log = (id: string) =>
      event(id, 'cv/1', { kind: 11, body: JSON.stringify({ seq: 1 }) });
    expect(store.publish(log('l1'), {}).result).toBe('accepted');
    expect(store.publish(log('l2'), {}).result).toBe('seq-taken');
    const bytes = Buffer.from('payload');
    const named = event('e2', 'bl/1', {
      body: JSON.stringify({ h: hashOf(bytes) })
    });
    expect(store.publish(named, {}).result).toBe(`payload ${hashOf(bytes)}`);
    expect(store.putPayload(`0x${hashOf(bytes)}`, bytes)).toBe('accepted');
    expect(store.putPayload(hashOf(bytes), Buffer.from('other'))).toBe(
      'rejected'
    );
    expect(store.publish(named, {}).result).toBe('accepted');
    expect(store.matching('dr').map((e) => e.event.id)).toEqual(['e1']);
    // Each log counts its own rseq: cv's first event is its 1.
    expect(store.matching('cv', 0).map((e) => e.rseq)).toEqual([1]);
  });

  it('keeps what was published for the next process', () => {
    new CrpRelayStore(dir).publish(event('e1', 'dr/1'), { wallet: '0x01' });
    const reopened = new CrpRelayStore(dir);
    expect(reopened.size).toBe(1);
    expect(reopened.publish(event('e1', 'dr/1'), {}).result).toBe('duplicate');
  });

  it('answers CRP frames over a WebSocket', async () => {
    const relay = await startCrpRelay(dir, RULES);
    const socket = new WebSocketClient(relay.url);
    const frames: Record<string, unknown>[] = [];
    const waitFor = (type: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const poll = () => {
          const found = frames.find((f) => f.t === type);
          if (found) resolve(found);
          else setTimeout(poll, 10);
        };
        poll();
      });
    socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve) => socket.on('open', resolve));
    try {
      socket.send(JSON.stringify({ t: 'HELLO', v: 1, net: 'test-net' }));
      expect(await waitFor('WELCOME')).toMatchObject({
        net: 'test-net',
        head: 1
      });
      await waitFor('CHALLENGE');
      socket.send(
        JSON.stringify({
          t: 'AUTH',
          rid: 1,
          grant: { wallet: '0xAB' },
          sig: '0x'
        })
      );
      expect(await waitFor('AUTHED')).toMatchObject({
        wallet: '0xab',
        roles: ['orderer', 'site-reader']
      });
      socket.send(
        JSON.stringify({
          t: 'PUB',
          rid: 2,
          event: event('e1', 'dr/1'),
          grant: {}
        })
      );
      expect(await waitFor('ACK')).toMatchObject({
        event_id: 'e1',
        status: 'accepted'
      });
      socket.send(
        JSON.stringify({
          t: 'HIST',
          rid: 3,
          wave: 'dr',
          after: null,
          limit: 10
        })
      );
      const res = await waitFor('RES');
      expect(
        (res.items as { event: { id: string } }[]).map((i) => i.event.id)
      ).toEqual(['e1']);
      expect(relay.problems()).toEqual([]);
    } finally {
      socket.close();
      await relay.stop();
    }
  });
});
