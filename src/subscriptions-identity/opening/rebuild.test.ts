import { RecordGrantProof } from '@/signed-records/record-event';
import { familyWave } from '@/signed-records/record-families';
import { RecordKind } from '@/signed-records/record-kinds';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import type { RecordLogReader } from '@/signed-records/record-log/record-log-reader';
import {
  appGrantFixture,
  bindingSource,
  signedRecord
} from '@/signed-records/record-test-fixtures';
import type { JournalBody } from '../timeline/journal';
import { verifyJournal } from '../timeline/journal-verify';
import { readJournal, replayedJournalSource } from './rebuild';

// Obviously fake keys.
const OPENING = 'a'.repeat(64);
const OWNER = `0x${'1'.padStart(64, '0')}`;

/** A choice entry naming a signed event, as the choice writer makes it. */
function choice(n: number, eventId: string): RecordLogEntry {
  const body: JournalBody = {
    t: 'journal',
    v: 2,
    kind: 'choice',
    n,
    part: 0,
    parts: 1,
    opening: OPENING,
    mode: 'truth',
    at_ms: n,
    inputs: {
      event_id: eventId,
      owner: OWNER,
      type: 'subs.mode',
      key: '',
      anchor: 1000,
      claimed_time: 1
    },
    changes: [
      {
        table: 'mode',
        key: { identity_key: OWNER },
        before: null,
        after: { identity_key: OWNER, automatic: 1 }
      }
    ],
    rekeys: [],
    checkpoint: null
  };
  return {
    t: 'entry',
    lane: 'subs',
    chain: 'public',
    body: body as unknown as Record<string, unknown>
  };
}

/**
 * The log's entries in order, as the records wave reader walks them; the
 * replay asks it for nothing else. `read` counts the entries handed out.
 */
function readerOf(
  entries: readonly RecordLogEntry[],
  read: { count: number } = { count: 0 }
): RecordLogReader {
  return {
    async *walk() {
      for (const entry of entries) {
        read.count++;
        yield { head: null, entry };
      }
    }
  } as unknown as RecordLogReader;
}

describe('replayedJournalSource', () => {
  it('checks each choice against its signed record, verified in the same walk', async () => {
    const { proof, grant } = await appGrantFixture();
    const record = (seq: number) =>
      signedRecord(grant, {
        kind: RecordKind.RECORD,
        wave: familyWave('ps', OWNER),
        refs: ['subs.mode'],
        body: { automatic: true },
        seq,
        anchor: 1000,
        claimedTime: Date.UTC(2026, 10, 25)
      });
    const signed = record(1);
    // Its proof's signature is not the wallet's, so the replay rejects it.
    const forged = record(2);
    const forgedProof: RecordGrantProof = {
      ...proof,
      wallet_signature: `0x${'ab'.repeat(65)}`
    };
    // A record of lane `personal` is replayed, but no choice may name it.
    const otherLane = record(3);
    const source = replayedJournalSource(
      readerOf([
        { t: 'event', lane: 'subs', event: signed, grant: proof },
        { t: 'event', lane: 'subs', event: forged, grant: forgedProof },
        { t: 'event', lane: 'personal', event: otherLane, grant: proof },
        choice(1, signed.id),
        choice(2, forged.id),
        choice(3, otherLane.id)
      ]),
      {
        bindings: bindingSource([
          { wallet: grant.wallet, principal: OWNER, from: 1 }
        ])
      }
    );
    const { bodies, events } = await readJournal(source);
    expect(bodies.map((b) => b.n)).toEqual([1, 2, 3]);
    expect(events).not.toBeNull();
    const report = await verifyJournal(bodies, {
      openingSha256: OPENING,
      events: events!
    });
    expect(report.checked.events).toBe(true);
    expect(report.failures).toEqual([
      `n=2 choice: event ${forged.id} is not a verified record in lane \`subs\``,
      `n=3 choice: event ${otherLane.id} is not a verified record in lane \`subs\``
    ]);
  });

  it('hands each entry on as the replay reaches it, one at a time', async () => {
    const read = { count: 0 };
    const source = replayedJournalSource(
      readerOf([choice(1, 'a'.repeat(32)), choice(2, 'b'.repeat(32))], read),
      { bindings: bindingSource([]) }
    );
    const walk = source.walk('public')[Symbol.asyncIterator]();
    const first = await walk.next();
    expect(first.value.verified).toBeNull();
    // The replay waits for the first entry to be taken before reading on.
    expect(read.count).toBe(1);
    expect((await walk.next()).done).toBe(false);
    expect(read.count).toBe(2);
    expect((await walk.next()).done).toBe(true);
  });

  it('ends the walk with the replay error', async () => {
    const reader = {
      async *walk() {
        yield { head: null, entry: choice(1, 'a'.repeat(32)) };
        throw new Error('segment 2 does not match its head');
      }
    } as unknown as RecordLogReader;
    await expect(
      readJournal(
        replayedJournalSource(reader, { bindings: bindingSource([]) })
      )
    ).rejects.toThrow('segment 2 does not match its head');
  });

  it('ends the replay when the reader stops partway', async () => {
    let closed = false;
    const reader = {
      async *walk() {
        try {
          for (let n = 1; n <= 3; n++) {
            yield { head: null, entry: choice(n, `${'a'.repeat(31)}${n}`) };
          }
        } finally {
          closed = true;
        }
      }
    } as unknown as RecordLogReader;
    const source = replayedJournalSource(reader, {
      bindings: bindingSource([])
    });
    let read = 0;
    for await (const _ of source.walk('public')) {
      read++;
      break;
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(read).toBe(1);
    // The replay moved on, refused its next entry and closed the reader.
    expect(closed).toBe(true);
  });

  it('gives no record lookup from a source that does not verify', async () => {
    const { bodies, events } = await readJournal({
      async *walk() {
        yield { entry: choice(1, 'f'.repeat(32)) };
      }
    });
    expect(bodies).toHaveLength(1);
    expect(events).toBeNull();
  });
});
