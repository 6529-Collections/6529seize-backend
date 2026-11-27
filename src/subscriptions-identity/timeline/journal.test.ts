import { applyJournalBody, JournalBody, journalKeyMismatch } from './journal';

// Obviously fake identity keys.
const P1 = `0x${'b1'.padStart(64, '0')}`;
const P2 = `0x${'b2'.padStart(64, '0')}`;

const row = (identity: string, balance: number) => ({
  identity_key: identity,
  balance,
  created_at: '2026-11-25 10:00:00.000000',
  updated_at: '2026-11-25 10:00:00.000000'
});

describe('journalKeyMismatch', () => {
  it('passes a change whose rows are the row its key names, and names any other', () => {
    expect(
      journalKeyMismatch({
        table: 'balances',
        key: { identity_key: P1 },
        before: row(P1, 1),
        after: row(P1, 2)
      })
    ).toBeNull();
    expect(
      journalKeyMismatch({
        table: 'balances',
        key: { identity_key: P1 },
        before: row(P1, 1),
        after: row(P2, 2)
      })
    ).toBe('its after row is another row');
    expect(
      journalKeyMismatch({
        table: 'final',
        key: { id: '7' },
        before: { id: 7 },
        after: null
      })
    ).toBeNull();
    expect(
      journalKeyMismatch({
        table: 'choices',
        key: { identity_key: P1 },
        after: { identity_key: P1 }
      })
    ).toBe('keyed by identity_key, not identity_key, contract, token_id');
  });
});

describe('applyJournalBody', () => {
  it('stops before writing anything when a row is not the one its key names', async () => {
    const body: JournalBody = {
      t: 'journal',
      v: 2,
      kind: 'top-up',
      n: 2,
      part: 0,
      parts: 1,
      opening: 'a'.repeat(64),
      mode: 'truth',
      at_ms: 1,
      inputs: {},
      changes: [
        {
          table: 'balances',
          key: { identity_key: P1 },
          before: row(P1, 1),
          after: row(P2, 1.5)
        }
      ],
      rekeys: [],
      checkpoint: null
    };
    // No connection is given: the check comes before any read or write.
    await expect(applyJournalBody(body, {})).rejects.toThrow(
      `Row balances {"identity_key":"${P1}"} of journal n=2 (top-up): its after row is another row`
    );
  });
});
