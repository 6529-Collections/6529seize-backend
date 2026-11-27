import { IngestRow, RejectRow } from '@/wave-drop-index/drop-index.db';
import { DropIndexStore } from '@/wave-drop-index/drop-index.subscriber';
import {
  firstSeenFactory,
  firstSeenOfItem,
  firstSeenStore,
  RelayFirstSeen
} from './waves-relay-first-seen';

const ID = `0x${'ab'.repeat(32)}`;
const OTHER = `0x${'cd'.repeat(32)}`;

describe('first-seen times from the relays', () => {
  it("takes an item's earliest receipt, else its recorded time", () => {
    expect(
      firstSeenOfItem({
        receipts: [{ received_at: 300 }, { received_at: 200 }],
        recorded_at: 100
      })
    ).toBe(200);
    expect(firstSeenOfItem({ receipts: [], recorded_at: 100 })).toBe(100);
    expect(firstSeenOfItem({ receipts: [] })).toBeNull();
    expect(
      firstSeenOfItem({
        receipts: [{ received_at: 'soon' }, { received_at: -1 }],
        recorded_at: 1.5
      })
    ).toBeNull();
  });

  it('notes EV frames and HIST pages by event id, keeping the earliest', () => {
    const seen = new RelayFirstSeen();
    seen.noteFrame({
      t: 'EV',
      event: { id: ID.toUpperCase() },
      receipts: [{ received_at: 500 }]
    });
    seen.noteFrame({
      t: 'RES',
      items: [
        { event: { id: ID }, receipts: [{ received_at: 400 }] },
        { event: { id: OTHER }, recorded_at: 700 }
      ]
    });
    seen.noteFrame({ t: 'EOSE', event: { id: OTHER }, recorded_at: 1 });
    expect(seen.of(ID)).toBe(400);
    expect(seen.of(OTHER)).toBe(700);
    expect(seen.of(null)).toBeUndefined();
  });

  it('gives the client every frame unchanged while noting it', () => {
    const seen = new RelayFirstSeen();
    const listeners: ((event: { data?: unknown }) => void)[] = [];
    const sent: string[] = [];
    const factory = firstSeenFactory(seen, () => ({
      readyState: 1,
      send: (data) => sent.push(data),
      close: () => undefined,
      addEventListener: (_type, listener) => listeners.push(listener)
    }));
    const socket = factory('ws://127.0.0.1:9');
    const heard: unknown[] = [];
    socket.addEventListener('message', (event) => heard.push(event.data));
    const frame = JSON.stringify({
      t: 'EV',
      event: { id: ID },
      receipts: [{ received_at: 42 }]
    });
    listeners[0]({ data: Buffer.from(frame) });
    listeners[0]({ data: 'not json' });
    socket.send('HELLO');
    expect(heard).toEqual([Buffer.from(frame), 'not json']);
    expect(sent).toEqual(['HELLO']);
    expect(seen.of(ID)).toBe(42);
  });

  it("stores rows and rejects at the relays' time, else as the subscriber set them", async () => {
    const seen = new RelayFirstSeen();
    seen.noteFrame({
      t: 'EV',
      event: { id: ID },
      receipts: [{ received_at: 10 }]
    });
    const ingest = jest.fn(async () => []);
    const inner: DropIndexStore = {
      cursors: jest.fn(),
      knownGrants: jest.fn(),
      siteEvents: jest.fn(),
      ingest
    };
    const row = (event_id: string) =>
      ({ event_id, received_at: 999 }) as IngestRow;
    const reject = (event_id: string | null) =>
      ({ event_id, received_at: 999 }) as RejectRow;
    await firstSeenStore(inner, seen).ingest(
      [row(ID), row(OTHER)],
      [reject(ID), reject(null)],
      'relay-1',
      [],
      999
    );
    expect(ingest).toHaveBeenCalledWith(
      [
        { event_id: ID, received_at: 10 },
        { event_id: OTHER, received_at: 999 }
      ],
      [
        { event_id: ID, received_at: 10 },
        { event_id: null, received_at: 999 }
      ],
      'relay-1',
      [],
      999
    );
  });
});
