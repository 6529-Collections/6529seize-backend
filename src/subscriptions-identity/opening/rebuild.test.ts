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

/** The log's entries in order, as the records wave reader walks them; the replay asks it for nothing else. */
function readerOf(entries: readonly RecordLogEntry[]): RecordLogReader {
  return {
    async *walk() {
      for (const entry of entries) {
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
    // A record of another lane is replayed, but no choice may name it.
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
      `n=2 choice: event ${forged.id} is not a verified record in lane subs`,
      `n=3 choice: event ${otherLane.id} is not a verified record in lane subs`
    ]);
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
