import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@/logging';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import type { JournalBody } from '../timeline/journal';
import { main } from './cli';
import { setJournalSource } from './rebuild';

// The CLI's commands run in a database context; this one reads no table.
jest.mock('@/secrets', () => ({
  doInDbContext: (fn: () => Promise<number>) => fn()
}));

// Obviously fake keys and hashes.
const OPENING = 'a'.repeat(64);
const P1 = `0x${'b1'.padStart(64, '0')}`;
const W1 = `0x${'1'.padStart(40, '0')}`;
const T = '2026-11-25 10:00:00.000000';

/** A top-up entry as the writer makes it, crediting `after`. */
function topUp(n: number, before: number | null, after: number): JournalBody {
  const amount = 0.1;
  const hash = `0x${n.toString(16).padStart(64, '0')}`;
  const row = (balance: number) => ({
    identity_key: P1,
    balance,
    created_at: T,
    updated_at: T
  });
  return {
    t: 'journal',
    v: 2,
    kind: 'top-up',
    n,
    part: 0,
    parts: 1,
    opening: OPENING,
    mode: 'truth',
    at_ms: n,
    inputs: {
      hash,
      block: n,
      transaction_date: T,
      from_wallet: W1,
      amount,
      identity_key: P1
    },
    changes: [
      {
        table: 'balances',
        key: { identity_key: P1 },
        before: before === null ? null : row(before),
        after: row(after)
      },
      {
        table: 'top_up',
        key: { hash },
        before: null,
        after: { hash, block: n, from_wallet: W1, amount, identity_key: P1 }
      }
    ],
    rekeys: [],
    checkpoint: null
  };
}

function bind(bodies: JournalBody[]) {
  const entries: RecordLogEntry[] = bodies.map((body) => ({
    t: 'entry',
    lane: 'subs',
    chain: 'public',
    body: body as unknown as Record<string, unknown>
  }));
  setJournalSource(() => ({
    async *walk() {
      for (const entry of entries) {
        yield { entry };
      }
    }
  }));
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  let out = '';
  const write = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    });
  try {
    return { code: await main(argv), out };
  } finally {
    write.mockRestore();
  }
}

describe('subscriptions:opening verify-journal', () => {
  afterEach(() => setJournalSource(null));

  it('passes a journal that keeps the money rules, and says what it did not check', async () => {
    bind([topUp(1, null, 0.1), topUp(2, 0.1, 0.2)]);
    const dir = mkdtempSync(join(tmpdir(), 'subs-verify-'));
    const { code, out } = await run([
      'verify-journal',
      '--no-ethereum',
      '--out',
      join(dir, 'report.json')
    ]);
    expect(code).toBe(0);
    expect(out.split('\n')).toEqual([
      `opening ${OPENING}: 2 writes, 2 top-ups, 0 charges over 0 mints, 0 choices`,
      'opening file: not checked (the journal names no published file for it; pass --opening --history)',
      'Ethereum: not checked (--no-ethereum)',
      'signed records: not checked (the bound source does not verify records)',
      'PASS',
      ''
    ]);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    expect(report).toMatchObject({ openingSha256: OPENING, failures: [] });
  });

  it('exits 2 and alerts when an entry breaks them', async () => {
    bind([topUp(1, null, 0.1), topUp(2, 0.1, 0.25)]);
    const alert = jest
      .spyOn(Logger.prototype, 'errorWithCode')
      .mockImplementation(() => undefined);
    try {
      const { code, out } = await run(['verify-journal', '--no-ethereum']);
      expect(code).toBe(2);
      expect(out).toContain(
        `FAIL n=2 top-up: the balance of ${P1} is 0.25 after a top-up of 0.1 to 0.1; expected 0.2`
      );
      expect(alert).toHaveBeenCalledWith(
        'SUBSCRIPTIONS_JOURNAL_VERIFY_FAILED',
        expect.stringContaining('1 failures')
      );
    } finally {
      alert.mockRestore();
    }
  });

  it('checks only the opening asked for', async () => {
    bind([{ ...topUp(1, null, 0.5), opening: 'b'.repeat(64) }]);
    const { code, out } = await run([
      'verify-journal',
      '--no-ethereum',
      '--opening-sha256',
      OPENING
    ]);
    expect(code).toBe(0);
    expect(out).toContain(`opening ${OPENING}: 0 writes`);
  });

  it('refuses to go live with a rebuild that skips Ethereum', async () => {
    const write = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      expect(await main(['rebuild', '--go-live', '--no-ethereum'])).toBe(2);
      expect(write).toHaveBeenCalledWith(
        'Refusing: a rebuild goes live only with its journal checked against Ethereum.\n'
      );
    } finally {
      write.mockRestore();
    }
  });

  it('refuses while no record log source is bound', async () => {
    await expect(main(['verify-journal'])).rejects.toThrow(
      'No record log source is bound'
    );
  });
});
