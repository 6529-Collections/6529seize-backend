import {
  decodeBinary,
  Frame,
  payloadRefs,
  StoredEvent
} from '@/rebuild/sources/crp-relay';
import {
  EV_FIELDS,
  ITEM_FIELDS,
  others,
  RelayRecording
} from '@/rebuild/sources/crp-relay-record';
import { writeProvenance } from '@/rebuild/sources/running-source';

interface WsClient {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: Buffer, binary: boolean) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: () => void): void;
  send(data: string): void;
  close(): void;
}
const WebSocket = require('ws') as new (url: string) => WsClient;

export interface CaptureOptions {
  /** The relay's CRP URL. */
  readonly url: string;
  /** Where the recording goes; what was there before is replaced. */
  readonly dir: string;
  /** The network name HELLO names; the relay refuses another. */
  readonly net: string;
  /** PROVENANCE.json's made_by: how the recording was really made. */
  readonly madeBy: string;
  /** The devnet scenario that made the events, when one did. */
  readonly devnetScenario?: string;
  /** AUTH as this wallet: only the harness relay takes AUTH without a signature. */
  readonly harnessWallet?: string;
  /** How long SUB's replay may stay quiet before it counts as done. */
  readonly quietMs?: number;
  /** A limit on each answer the relay owes. */
  readonly timeoutMs?: number;
}

const HIST_PAGE = 500;

/**
 * Records a whole relay into a recording `replay:<dir>` serves: every
 * log SUB `*` replays from the start, each paged through HIST to its end
 * (so a replay limit's RESYNC loses nothing), and every payload the
 * events name. reads.json holds `*` and each log, so a run that reads any
 * of them replays. No file holds the relay's address.
 */
export async function captureRelay(options: CaptureOptions): Promise<{
  events: number;
  logs: string[];
  payloads: number;
}> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const quietMs = options.quietMs ?? 2_000;
  const recording = new RelayRecording(options.dir);
  const socket = new WebSocket(options.url);
  const logs = new Set<string>();
  const answers = new Map<number, (frame: Frame) => void>();
  const payloadAnswers = new Map<number, () => void>();
  let lastFrame = Date.now();
  let welcome: (() => void) | null = null;
  let authed: (() => void) | null = null;
  let failure: Error | null = null;
  socket.on('error', (error) => {
    failure = error;
  });
  socket.on('message', (data, binary) => {
    lastFrame = Date.now();
    if (binary) {
      const { header, bytes } = decodeBinary(data);
      if (header.t === 'PAYLOAD') {
        recording.payload(String(header.sha256), bytes);
        payloadAnswers.get(Number(header.rid))?.();
      }
      return;
    }
    const frame = JSON.parse(data.toString('utf8')) as Frame;
    switch (frame.t) {
      case 'WELCOME':
        if (typeof frame.head === 'number') recording.welcome(frame.head);
        welcome?.();
        return;
      case 'AUTHED':
        recording.authed(String(frame.wallet), (frame.roles as string[]) ?? []);
        authed?.();
        return;
      case 'EV':
        logs.add(String(frame.wave));
        recording.event(
          frame.event as StoredEvent['event'],
          (frame.grant ?? {}) as StoredEvent['grant'],
          Number(frame.rseq),
          others(frame, EV_FIELDS)
        );
        return;
      case 'EOSE':
      case 'RESYNC':
        logs.add(String(frame.wave));
        return;
      case 'RES':
        answers.get(Number(frame.rid))?.(frame);
        return;
      case 'ERR':
        if (payloadAnswers.has(Number(frame.rid))) {
          payloadAnswers.get(Number(frame.rid))?.();
        } else if (answers.has(Number(frame.rid))) {
          answers.get(Number(frame.rid))?.(frame);
        }
        return;
      default:
        return;
    }
  });
  const within = <T>(what: string, promise: Promise<T>): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(failure ?? new Error(`The relay sent no ${what} in time`)),
          timeoutMs
        ).unref()
      )
    ]);
  const send = (frame: Record<string, unknown>) =>
    socket.send(JSON.stringify(frame));
  try {
    await within(
      'connection',
      new Promise<void>((resolve) => socket.on('open', resolve))
    );
    const welcomed = new Promise<void>((resolve) => (welcome = resolve));
    send({ t: 'HELLO', v: 1, net: options.net, role: 'client' });
    await within('WELCOME', welcomed);
    if (options.harnessWallet) {
      const done = new Promise<void>((resolve) => (authed = resolve));
      send({
        t: 'AUTH',
        rid: 0,
        grant: { wallet: options.harnessWallet },
        sig: '0x'
      });
      await within('AUTHED', done);
    }
    // Every log from its start, until the replay goes quiet.
    recording.read('*');
    send({ t: 'SUB', sid: 1, waves: ['*'], since: [], from_start: true });
    await within(
      'end to its replay',
      new Promise<void>((resolve) => {
        const poll = () =>
          Date.now() - lastFrame >= quietMs
            ? resolve()
            : setTimeout(poll, quietMs / 4).unref();
        setTimeout(poll, quietMs / 4).unref();
      })
    );
    send({ t: 'UNSUB', sid: 1 });
    // Each log paged to its end: what a RESYNC or a quiet spell left out.
    let rid = 1;
    for (const log of Array.from(logs)) {
      recording.read(log);
      let after = 0;
      for (;;) {
        const id = rid++;
        const answer = new Promise<Frame>((resolve) =>
          answers.set(id, resolve)
        );
        send({ t: 'HIST', rid: id, wave: log, after, limit: HIST_PAGE });
        const page = await within(`HIST answer for ${log}`, answer);
        answers.delete(id);
        if (page.t === 'ERR') {
          throw new Error(`HIST ${log}: ${String(page.reason)}`);
        }
        const items = (page.items as Record<string, unknown>[]) ?? [];
        for (const item of items) {
          recording.event(
            item.event as StoredEvent['event'],
            (item.grant ?? {}) as StoredEvent['grant'],
            Number(item.rseq),
            others(item, ITEM_FIELDS)
          );
        }
        const last = items[items.length - 1];
        if (page.more !== true || !last) break;
        after = Number(last.rseq);
      }
    }
    // Every payload the events name.
    const hashes = new Set(
      recording.events().flatMap((event) => payloadRefs(event.body))
    );
    for (const sha256 of Array.from(hashes)) {
      const id = rid++;
      const answered = new Promise<void>((resolve) =>
        payloadAnswers.set(id, resolve)
      );
      send({ t: 'PAYLOAD_GET', rid: id, sha256 });
      await within(`payload ${sha256}`, answered);
      payloadAnswers.delete(id);
    }
    const events = recording.save();
    writeProvenance(options.dir, {
      made_by: options.madeBy,
      ...(options.devnetScenario
        ? { devnet_scenario: options.devnetScenario }
        : {}),
      recorded_at: new Date().toISOString()
    } as Parameters<typeof writeProvenance>[1]);
    return { events, logs: Array.from(logs), payloads: hashes.size };
  } finally {
    socket.close();
  }
}
