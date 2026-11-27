import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RebuildContext } from '@/rebuild/manifest.types';
import { FILE_INDEX } from '@/rebuild/sources/file-server';
import { SqlExecutor } from '@/sql-executor';
import {
  fetchSwitchOnRecord,
  loadSwitchOnRecord,
  RECORD_LOAD_BATCH,
  SwitchOnRecordPins,
  takeSwitchOnRecord,
  WORLD_RECORD_PINS_ID,
  writeSwitchOnRecordFixture
} from './switch-on-record';
import {
  formatTdhOnlyRecord,
  sha256Hex,
  TdhOnlyRecord,
  TdhOnlyRecordError
} from './tdh-only-record';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const FILES = 'http://127.0.0.1:4200/files';

// A TDH-only identity as step B leaves it, an address-only one a chain
// identity adopts, and one with no profile id at all.
const RECORD: TdhOnlyRecord = {
  rows: [
    {
      consolidation_key: W(9),
      profile_id: '5b0c7f4e-3b4f-4d51-9a3e-0c6a2f1d8e90',
      primary_address: W(9),
      tdh: 400,
      rep: 0,
      cic: 0,
      level_raw: 400
    },
    {
      consolidation_key: W(14),
      profile_id: '00000000-0000-4000-8000-00000000010e',
      primary_address: W(14),
      tdh: 0,
      rep: 0,
      cic: 0,
      level_raw: 0
    },
    {
      consolidation_key: W(15),
      profile_id: null,
      primary_address: W(15),
      tdh: 0,
      rep: 0,
      cic: 0,
      level_raw: 0
    }
  ],
  keys: [
    { address: W(9), consolidation_key: W(9) },
    { address: W(14), consolidation_key: W(14) },
    { address: W(15), consolidation_key: W(15) }
  ]
};
const FORMATTED = formatTdhOnlyRecord(RECORD.rows, RECORD.keys);
const PINS: SwitchOnRecordPins = {
  identitiesSha256: FORMATTED.identitiesSha256,
  keysSha256: FORMATTED.keysSha256
};

function ctx(over: Partial<RebuildContext> = {}): RebuildContext {
  return {
    area: 'identity',
    stepId: 'identity.chain-mirror',
    sources: {
      gateway: null,
      relays: null,
      ethereum: null,
      files: FILES,
      repo: null
    },
    seedFilesDir: null,
    mark: { name: 'head', chainHeight: null, ethBlock: null },
    final: false,
    ...over
  };
}

/** A files source serving the given files by id; records what was asked. */
function filesSource(served: Record<string, string>) {
  const asked: string[] = [];
  const fetchImpl = jest.fn(async (url: string | URL | Request) => {
    const id = String(url).slice(`${FILES}/`.length);
    asked.push(id);
    const text = served[id];
    return text === undefined
      ? new Response('missing', { status: 404 })
      : new Response(text, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

const WORLD_SERVED = {
  [PINS.identitiesSha256]: FORMATTED.identitiesTsv,
  [PINS.keysSha256]: FORMATTED.keysTsv,
  [WORLD_RECORD_PINS_ID]: `${JSON.stringify(PINS)}\n`
};

describe('writeSwitchOnRecordFixture', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-on-record-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('puts both files by their SHA-256 and the pins file into the seed files, listed in its index', () => {
    fs.writeFileSync(
      path.join(dir, FILE_INDEX),
      JSON.stringify({ other: 'ab'.repeat(32) })
    );
    expect(writeSwitchOnRecordFixture(dir, FORMATTED)).toEqual(PINS);
    expect(fs.readFileSync(path.join(dir, PINS.identitiesSha256), 'utf8')).toBe(
      FORMATTED.identitiesTsv
    );
    expect(fs.readFileSync(path.join(dir, PINS.keysSha256), 'utf8')).toBe(
      FORMATTED.keysTsv
    );
    const pinsText = fs.readFileSync(
      path.join(dir, WORLD_RECORD_PINS_ID),
      'utf8'
    );
    expect(JSON.parse(pinsText)).toEqual(PINS);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, FILE_INDEX), 'utf8'))
    ).toEqual({
      other: 'ab'.repeat(32),
      [PINS.identitiesSha256]: PINS.identitiesSha256,
      [PINS.keysSha256]: PINS.keysSha256,
      [WORLD_RECORD_PINS_ID]: sha256Hex(pinsText)
    });
  });
});

describe('fetchSwitchOnRecord', () => {
  it("reads the world's take by the pins its seed wrote", async () => {
    const { fetchImpl, asked } = filesSource(WORLD_SERVED);
    await expect(fetchSwitchOnRecord(ctx(), null, fetchImpl)).resolves.toEqual({
      record: RECORD,
      fixture: true
    });
    expect(asked).toEqual([
      WORLD_RECORD_PINS_ID,
      PINS.identitiesSha256,
      PINS.keysSha256
    ]);
  });

  it("reads the team's take by the pinned SHA-256s, on a final run too", async () => {
    const { fetchImpl, asked } = filesSource(WORLD_SERVED);
    await expect(
      fetchSwitchOnRecord(ctx({ final: true }), PINS, fetchImpl)
    ).resolves.toEqual({ record: RECORD, fixture: false });
    expect(asked).not.toContain(WORLD_RECORD_PINS_ID);
  });

  it("refuses the world's take on a final run, before it reads a file", async () => {
    const { fetchImpl, asked } = filesSource(WORLD_SERVED);
    await expect(
      fetchSwitchOnRecord(ctx({ final: true }), null, fetchImpl)
    ).rejects.toThrow(/not pinned yet; a final run reads the team's take/);
    expect(asked).toEqual([]);
  });

  it('refuses a run without a files source', async () => {
    const { fetchImpl } = filesSource(WORLD_SERVED);
    await expect(
      fetchSwitchOnRecord(
        ctx({
          sources: {
            gateway: null,
            relays: null,
            ethereum: null,
            files: null,
            repo: null
          }
        }),
        PINS,
        fetchImpl
      )
    ).rejects.toThrow(/--source files=<dir>/);
  });

  it('refuses a file that is not the pinned one', async () => {
    const { fetchImpl } = filesSource({
      ...WORLD_SERVED,
      [PINS.keysSha256]: FORMATTED.keysTsv.replace(W(15), W(16))
    });
    await expect(fetchSwitchOnRecord(ctx(), PINS, fetchImpl)).rejects.toThrow(
      TdhOnlyRecordError
    );
  });

  it('refuses a missing file and a pins file that names no SHA-256s', async () => {
    const missing = filesSource({
      [WORLD_RECORD_PINS_ID]: JSON.stringify(PINS)
    });
    await expect(
      fetchSwitchOnRecord(ctx(), null, missing.fetchImpl)
    ).rejects.toThrow(/no switch-on record's identities file .* \(404\)/);
    const bad = filesSource({
      [WORLD_RECORD_PINS_ID]: JSON.stringify({ identitiesSha256: 'x' })
    });
    await expect(
      fetchSwitchOnRecord(ctx(), null, bad.fetchImpl)
    ).rejects.toThrow(/does not name two SHA-256s/);
  });
});

/** A database that records each statement and answers selects in turn. */
function fakeDb(answers: unknown[][] = []) {
  const statements: { sql: string; params: any; connection: unknown }[] = [];
  const db = {
    execute: jest.fn(async (sql: string, params?: any, options?: any) => {
      statements.push({
        sql,
        params,
        connection: options?.wrappedConnection
      });
      return answers.shift() ?? [];
    }),
    executeNativeQueriesInTransaction: jest.fn(
      async (work: (connection: unknown) => Promise<unknown>) =>
        work('the transaction')
    )
  };
  return { db: db as unknown as SqlExecutor, statements };
}

describe('takeSwitchOnRecord', () => {
  it("runs the team's two selections and reads the numbers as numbers", async () => {
    const { db, statements } = fakeDb([
      [{ ...RECORD.rows[0], tdh: '400', level_raw: '400' }],
      [RECORD.keys[0]]
    ]);
    await expect(takeSwitchOnRecord(db)).resolves.toEqual({
      rows: [RECORD.rows[0]],
      keys: [RECORD.keys[0]]
    });
    expect(statements).toHaveLength(2);
    for (const { sql } of statements) {
      expect(sql).toMatch(/i\.handle is null/);
      expect(sql).toMatch(
        /not exists \(select 1 from identity_chain_principals m\s+where m\.profile_id = i\.profile_id\)/
      );
    }
    expect(statements[0].sql).toMatch(/order by i\.consolidation_key/);
    expect(statements[1].sql).toMatch(/order by a\.address/);
  });
});

describe('loadSwitchOnRecord', () => {
  it("writes the record's columns of each row and each key, in one transaction", async () => {
    const { db, statements } = fakeDb();
    await expect(loadSwitchOnRecord(RECORD, db)).resolves.toEqual({
      identities: 3,
      keys: 3
    });
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toMatch(
      /insert into identities\s+\(consolidation_key, profile_id, primary_address, tdh, rep, cic, level_raw\)/
    );
    expect(Object.values(statements[0].params)).toEqual(
      RECORD.rows.flatMap((row) => [
        row.consolidation_key,
        row.profile_id,
        row.primary_address,
        row.tdh,
        row.rep,
        row.cic,
        row.level_raw
      ])
    );
    expect(statements[1].sql).toMatch(
      /insert into address_consolidation_keys \(address, consolidation_key\)/
    );
    expect(Object.values(statements[1].params)).toEqual(
      RECORD.keys.flatMap((key) => [key.address, key.consolidation_key])
    );
    expect(statements.map((it) => it.connection)).toEqual([
      'the transaction',
      'the transaction'
    ]);
  });

  it('writes a large record in batches', async () => {
    const many = RECORD_LOAD_BATCH + 1;
    const rows = Array.from({ length: many }, (_, i) => ({
      ...RECORD.rows[1],
      consolidation_key: W(0x1000 + i),
      primary_address: W(0x1000 + i),
      profile_id: null
    }));
    const keys = rows.map((row) => ({
      address: row.primary_address,
      consolidation_key: row.consolidation_key
    }));
    const { db, statements } = fakeDb();
    await loadSwitchOnRecord({ rows, keys }, db);
    expect(statements).toHaveLength(4);
    expect(Object.keys(statements[0].params)).toHaveLength(
      RECORD_LOAD_BATCH * 7
    );
    expect(Object.keys(statements[1].params)).toHaveLength(7);
    expect(Object.keys(statements[2].params)).toHaveLength(
      RECORD_LOAD_BATCH * 2
    );
    expect(Object.keys(statements[3].params)).toHaveLength(2);
  });

  it('writes nothing for an empty record', async () => {
    const { db, statements } = fakeDb();
    await expect(
      loadSwitchOnRecord({ rows: [], keys: [] }, db)
    ).resolves.toEqual({ identities: 0, keys: 0 });
    expect(statements).toEqual([]);
  });
});
