const mockDoInDbContext = jest.fn();
jest.mock('@/secrets', () => ({
  doInDbContext: (...args: unknown[]) => mockDoInDbContext(...args)
}));
jest.mock('./waves-export.backend-source', () => ({
  BackendWavesExportSource: jest.fn()
}));
const mockExecute = jest.fn();
const mockTransaction = jest.fn();
jest.mock('@/sql-executor', () => ({
  ...jest.requireActual('@/sql-executor'),
  sqlExecutor: {
    execute: (...args: unknown[]) => mockExecute(...args),
    executeNativeQueriesInTransaction: (...args: unknown[]) =>
      mockTransaction(...args)
  }
}));
// True while the export's reads go through the API's SQL executor.
let mockInApiSqlExecutor = false;
const mockScopeOptions: unknown[] = [];
jest.mock('./waves-export.db', () => ({
  withApiSqlExecutor: async (
    action: () => Promise<unknown>,
    options: unknown
  ) => {
    mockScopeOptions.push(options);
    mockInApiSqlExecutor = true;
    try {
      return await action();
    } finally {
      mockInApiSqlExecutor = false;
    }
  }
}));
const mockWavesExport = jest.fn();
jest.mock('./waves-export.service', () => ({
  ...jest.requireActual('./waves-export.service'),
  WavesExport: jest.fn((...args: unknown[]) => mockWavesExport(...args))
}));

import {
  EXPORT_AFTER_FREEZE_MS,
  main,
  recordsWaveIdFor,
  refuseBeforeExportStart,
  runExport
} from './cli';
import {
  parseWavesExportCommand,
  WavesExportCommand,
  WavesExportUsageError
} from './cli-options';
import {
  ALL_READERS_LAG_SQL,
  INNODB_READ_ONLY_SQL,
  READ_ONLY_SQL
} from './waves-export.replica-lag';

const REVISION = 'ab'.repeat(20);
const T_W = Date.UTC(2026, 10, 25, 0, 0, 0);
const EXPORT = [
  '--out',
  'OUT',
  '--revision',
  REVISION,
  '--freeze-at',
  '2026-11-25T00:00:00Z'
];

describe('waves:export and the freeze time', () => {
  let tz: string | undefined;
  beforeEach(() => {
    tz = process.env.TZ;
    mockDoInDbContext.mockReset().mockResolvedValue({ failed_waves: [] });
    jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it('refuses to export before the freeze, without reading the database', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(T_W - 1);
    await expect(main(EXPORT)).rejects.toThrow(WavesExportUsageError);
    await expect(main(EXPORT)).rejects.toThrow(
      'The waves freeze is at 2026-11-25T00:00:00.000Z'
    );
    expect(mockDoInDbContext).not.toHaveBeenCalled();
  });

  it.each([
    ['at the freeze', T_W],
    ['a minute after it', T_W + 60_000],
    ['just under five minutes after it', T_W + EXPORT_AFTER_FREEZE_MS - 1]
  ])('refuses to export %s, naming the earliest start', async (_when, now) => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const refusal = main(EXPORT);
    await expect(refusal).rejects.toThrow(
      'The export starts from 2026-11-25T00:05:00.000Z'
    );
    await expect(refusal).rejects.toMatchObject({ showHelp: false });
    await expect(refusal).rejects.not.toThrow('--rehearsal');
    expect(mockDoInDbContext).not.toHaveBeenCalled();
  });

  it('exports from five minutes after the freeze on', async () => {
    expect(EXPORT_AFTER_FREEZE_MS).toBe(300_000);
    jest.spyOn(Date, 'now').mockReturnValue(T_W + EXPORT_AFTER_FREEZE_MS);
    await main(EXPORT);
    expect(mockDoInDbContext).toHaveBeenCalledTimes(1);
  });

  it('runs a rehearsal before the freeze', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(T_W - 1);
    await main(['--out', 'OUT', '--revision', REVISION, '--rehearsal']);
    expect(mockDoInDbContext).toHaveBeenCalledTimes(1);
  });

  it('gives the same time check to any caller, on its own clock', () => {
    expect(() =>
      refuseBeforeExportStart(T_W, T_W + EXPORT_AFTER_FREEZE_MS - 1)
    ).toThrow('The export starts from 2026-11-25T00:05:00.000Z');
    expect(refuseBeforeExportStart(T_W, T_W + EXPORT_AFTER_FREEZE_MS)).toBe(
      T_W + EXPORT_AFTER_FREEZE_MS
    );
    // A rehearsal has no time check.
    expect(refuseBeforeExportStart(null, 0)).toBeNull();
  });
});

describe('waves:export and the read replica lag', () => {
  const NOW = T_W + EXPORT_AFTER_FREEZE_MS + 60_000;
  const reader = (lag: number) => ({
    server_id: 'r1',
    session_id: 'session-r1',
    lag_ms: lag,
    age_ms: 5,
    now_ms: NOW
  });
  /** DB_HOST answers the check's queries: an Aurora reader by default. */
  const dbHost = (lag: unknown[] | Error, { ro = 0, iro = 1 } = {}) =>
    mockExecute.mockImplementation(async (sql: string) => {
      if (sql === READ_ONLY_SQL) return [{ ro }];
      if (sql === INNODB_READ_ONLY_SQL) return [{ iro }];
      if (lag instanceof Error) throw lag;
      return lag;
    });
  const PERSON_FLAGS = [
    '--replica-lag-checked-by',
    'the operator',
    '--replica-lag-check-note',
    'AuroraReplicaLagMaximum read at 00:06 UTC: 20 ms'
  ];
  const replicaLagGiven = () => mockWavesExport.mock.calls[0][1].replicaLag;
  const sqlRun = () => mockExecute.mock.calls.map(([sql]) => sql);
  let tz: string | undefined;
  let recordsWave: string | undefined;
  let stderr: string[];
  beforeEach(() => {
    tz = process.env.TZ;
    recordsWave = process.env.SIGNED_RECORDS_WAVE_ID;
    process.env.SIGNED_RECORDS_WAVE_ID = 'w-records';
    mockDoInDbContext
      .mockReset()
      .mockImplementation((work: () => Promise<unknown>) => work());
    mockExecute.mockReset();
    mockTransaction
      .mockReset()
      .mockImplementation(
        (work: (connection: { connection: string }) => Promise<unknown>) =>
          work({ connection: 'one' })
      );
    mockWavesExport
      .mockReset()
      .mockReturnValue({ run: async () => ({ failed_waves: [] }) });
    stderr = [];
    jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
    if (recordsWave === undefined) delete process.env.SIGNED_RECORDS_WAVE_ID;
    else process.env.SIGNED_RECORDS_WAVE_ID = recordsWave;
  });

  it('keeps the records wave on 6529.io, by its setting or the environment', async () => {
    dbHost([reader(40)]);
    await main(EXPORT);
    expect(mockWavesExport.mock.calls[0][1].recordsWaveId).toBe('w-records');
    await main([...EXPORT, '--records-wave-id', 'w-records']);
    expect(mockWavesExport.mock.calls[1][1].recordsWaveId).toBe('w-records');
    delete process.env.SIGNED_RECORDS_WAVE_ID;
    await main([...EXPORT, '--records-wave-id', 'w-other']);
    expect(mockWavesExport.mock.calls[2][1].recordsWaveId).toBe('w-other');
    // None, on purpose: no records wave, said in the log.
    await main([...EXPORT, '--records-wave-id', 'none']);
    expect(mockWavesExport.mock.calls[3][1].recordsWaveId).toBeNull();
    expect(stderr.join('')).toContain(
      'no records wave: the records wave setting is none, so no wave stays as the records wave'
    );
    // Neither: refused before any read.
    mockExecute.mockClear();
    await expect(main(EXPORT)).rejects.toThrow(
      'The export needs the signed records wave'
    );
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockWavesExport).toHaveBeenCalledTimes(4);
  });

  it("reads DB_HOST's state and every reader's lag before any stage, and records it", async () => {
    dbHost([reader(40)]);
    await main(EXPORT);
    // All three on one connection, in one transaction.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls).toEqual(
      [READ_ONLY_SQL, INNODB_READ_ONLY_SQL, ALL_READERS_LAG_SQL].map((sql) => [
        sql,
        undefined,
        { wrappedConnection: { connection: 'one' } }
      ])
    );
    expect(Math.max(...mockExecute.mock.invocationCallOrder)).toBeLessThan(
      mockWavesExport.mock.invocationCallOrder[0]
    );
    expect(replicaLagGiven()).toEqual({
      checked_by: 'export',
      read_at: new Date(NOW).toISOString(),
      server_read_only: true,
      readers: 1,
      worst_lag_ms: 40,
      worst_lag_age_ms: 5,
      stale_readers: 0,
      unknown_reason: null
    });
  });

  it("reads the lag and runs every stage through the API's SQL executor", async () => {
    dbHost([reader(40)]);
    const answer = mockExecute.getMockImplementation()!;
    const inside: boolean[] = [];
    mockExecute.mockImplementation(async (...args: unknown[]) => {
      inside.push(mockInApiSqlExecutor);
      return answer(...args);
    });
    mockWavesExport.mockReturnValue({
      run: async () => {
        inside.push(mockInApiSqlExecutor);
        return { failed_waves: [] };
      }
    });
    await main(EXPORT);
    expect(inside).toEqual([true, true, true, true]);
    expect(mockInApiSqlExecutor).toBe(false);
  });

  it('reads the lag first on a resumed run of later stages too', async () => {
    dbHost([reader(40)]);
    await main([...EXPORT, '--stages', 'drops', '--resume']);
    expect(sqlRun()).toContain(ALL_READERS_LAG_SQL);
    expect(Math.max(...mockExecute.mock.invocationCallOrder)).toBeLessThan(
      mockWavesExport.mock.invocationCallOrder[0]
    );
    expect(mockWavesExport.mock.calls[0][1]).toMatchObject({
      stages: ['drops'],
      resumeDrops: true,
      replicaLag: { checked_by: 'export' }
    });
  });

  it("passes a caller's stopBeforeWave to the export, and the command line passes none", async () => {
    dbHost([reader(40)]);
    const command = parseWavesExportCommand([
      ...EXPORT,
      '--stages',
      'drops',
      '--resume'
    ]) as WavesExportCommand;
    const stopBeforeWave = () => true;
    mockScopeOptions.length = 0;
    await runExport(command, { stopBeforeWave, keepDbScope: true });
    expect(mockWavesExport.mock.calls[0][1]).toMatchObject({
      stages: ['drops'],
      resumeDrops: true,
      stopBeforeWave
    });
    await main(EXPORT);
    expect(mockWavesExport.mock.calls[1][1].stopBeforeWave).toBeUndefined();
    // A job keeps the DB scope for its next stage; the command line doesn't.
    expect(mockScopeOptions).toEqual([
      { keepOpen: true },
      { keepOpen: undefined }
    ]);
  });

  it('refuses before any stage reads when a reader is too far behind', async () => {
    dbHost([reader(60_000)]);
    const refusal = main(EXPORT);
    await expect(refusal).rejects.toThrow(WavesExportUsageError);
    await expect(refusal).rejects.toThrow(
      'The read replica may be up to 61.5 s behind'
    );
    expect(mockWavesExport).not.toHaveBeenCalled();
  });

  it("refuses a DB_HOST that isn't read-only before any stage reads", async () => {
    dbHost([reader(40)], { ro: 0, iro: 0 });
    await expect(main(EXPORT)).rejects.toThrow(
      "DB_HOST's server is not read-only"
    );
    expect(mockWavesExport).not.toHaveBeenCalled();
  });

  it('names the setting a caller says the run reads through', async () => {
    dbHost([reader(40)], { ro: 0, iro: 0 });
    const command = parseWavesExportCommand(EXPORT) as WavesExportCommand;
    await expect(
      runExport(command, { keepDbScope: true, hostSetting: 'DB_HOST_READ' })
    ).rejects.toThrow(
      "DB_HOST_READ's server is not read-only (read_only and innodb_read_only are both off), so it is not a read replica, and the export reads only from one. Point the function's DB_HOST_READ"
    );
    expect(mockWavesExport).not.toHaveBeenCalled();
  });

  it('names DB_IAM_HOST in IAM mode, with all four IAM settings', async () => {
    const iam = {
      DB_IAM_AUTH: 'true',
      DB_IAM_HOST: 'iam-host',
      DB_IAM_USER: 'iam-user',
      DB_IAM_HOST_READ: 'iam-host-read',
      DB_IAM_USER_READ: 'iam-user-read'
    };
    const saved = Object.fromEntries(
      Object.keys(iam).map((key) => [key, process.env[key]])
    );
    Object.assign(process.env, iam);
    try {
      dbHost([reader(40)], { ro: 0, iro: 0 });
      await expect(main(EXPORT)).rejects.toThrow(
        "DB_IAM_HOST's server is not read-only"
      );
      // Without all four, the export reads through DB_HOST.
      delete process.env.DB_IAM_USER_READ;
      await expect(main(EXPORT)).rejects.toThrow(
        "DB_HOST's server is not read-only"
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("goes ahead on a person's word when it can't tell, loudly, with what it read", async () => {
    dbHost([]);
    await main([...EXPORT, ...PERSON_FLAGS]);
    expect(sqlRun()).toContain(ALL_READERS_LAG_SQL);
    expect(replicaLagGiven()).toMatchObject({
      checked_by: 'person',
      person: 'the operator',
      note: 'AuroraReplicaLagMaximum read at 00:06 UTC: 20 ms',
      server_read_only: true,
      readers: 0,
      unknown_reason:
        'information_schema.replica_host_status has no row for any reader'
    });
    expect(stderr.join('')).toContain(
      'It goes ahead on the word of "the operator", who checked it this way: "AuroraReplicaLagMaximum read at 00:06 UTC: 20 ms"'
    );
  });

  it("refuses a person's word when it can read the lag", async () => {
    dbHost([reader(40)]);
    await expect(main([...EXPORT, ...PERSON_FLAGS])).rejects.toThrow(
      "which are only for when it can't tell"
    );
    expect(mockWavesExport).not.toHaveBeenCalled();
  });

  it('reports the lag in a rehearsal and never refuses on it', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(T_W - 1);
    dbHost([reader(600_000)]);
    await main(['--out', 'OUT', '--revision', REVISION, '--rehearsal']);
    expect(sqlRun()).toContain(ALL_READERS_LAG_SQL);
    expect(replicaLagGiven()).toMatchObject({
      checked_by: 'rehearsal',
      readers: 1,
      worst_lag_ms: 600_000,
      unknown_reason: null
    });
    expect(stderr.join('')).toContain(
      'rehearsal: its one reader has a lag of 600000 ms'
    );
  });

  it('runs a rehearsal when the queries fail, and records why', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(T_W - 1);
    mockExecute.mockRejectedValue(
      Object.assign(new Error('no such table'), { code: 'ER_NO_SUCH_TABLE' })
    );
    await main(['--out', 'OUT', '--revision', REVISION, '--rehearsal']);
    expect(mockWavesExport).toHaveBeenCalledTimes(1);
    expect(replicaLagGiven()).toMatchObject({
      checked_by: 'rehearsal',
      server_read_only: null,
      readers: null,
      unknown_reason:
        'reading @@GLOBAL.read_only failed (ER_NO_SUCH_TABLE); reading information_schema.replica_host_status failed (ER_NO_SUCH_TABLE)'
    });
  });
});

describe('the records wave the export keeps on 6529.io', () => {
  it('takes the setting, else SIGNED_RECORDS_WAVE_ID', () => {
    expect(recordsWaveIdFor('w-1', {})).toBe('w-1');
    expect(recordsWaveIdFor(null, { SIGNED_RECORDS_WAVE_ID: ' w-2 ' })).toBe(
      'w-2'
    );
    expect(recordsWaveIdFor('w-3', { SIGNED_RECORDS_WAVE_ID: 'w-3' })).toBe(
      'w-3'
    );
  });

  it('takes none, given on purpose, as no records wave', () => {
    expect(recordsWaveIdFor('none', {})).toBeNull();
    // In any case, as 6529.io reads the setting.
    expect(recordsWaveIdFor('NONE', {})).toBeNull();
    expect(
      recordsWaveIdFor('none', { SIGNED_RECORDS_WAVE_ID: ' None ' })
    ).toBeNull();
    expect(
      recordsWaveIdFor(null, { SIGNED_RECORDS_WAVE_ID: 'none' })
    ).toBeNull();
    expect(
      recordsWaveIdFor('none', { SIGNED_RECORDS_WAVE_ID: 'none' })
    ).toBeNull();
    // None against an id is a disagreement, not a choice.
    expect(() =>
      recordsWaveIdFor('none', { SIGNED_RECORDS_WAVE_ID: 'w-2' })
    ).toThrow('--records-wave-id none and SIGNED_RECORDS_WAVE_ID w-2');
  });

  it('refuses when neither names it, or the two differ', () => {
    for (const env of [{}, { SIGNED_RECORDS_WAVE_ID: '  ' }]) {
      expect(() => recordsWaveIdFor(null, env)).toThrow(
        'The export needs the signed records wave, which stays on 6529.io: give --records-wave-id <its id>, or set SIGNED_RECORDS_WAVE_ID (or give --records-wave-id none when there is none). Without it the records wave would move with the rest.'
      );
    }
    expect(() =>
      recordsWaveIdFor('w-1', { SIGNED_RECORDS_WAVE_ID: 'w-2' })
    ).toThrow(
      '--records-wave-id w-1 and SIGNED_RECORDS_WAVE_ID w-2 name different waves'
    );
  });
});
