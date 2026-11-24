import { REPLICA_LAG_AGE_MARGIN_MS } from '@/dbDumpsDaily/chain-exports/replica-snapshot';
import { WavesExportUsageError } from './cli-options';
import {
  ALL_READERS_LAG_SQL,
  checkReplicaLag,
  replicaLagAtStart
} from './waves-export.replica-lag';

const T_W = Date.UTC(2026, 10, 25, 0, 0, 0);
/** Five minutes after the freeze: every reader must be past it. */
const CAUGHT_UP = T_W + 5 * 60 * 1000;
/** A minute later: a reader may be up to 60 s behind, margin included. */
const NOW = CAUGHT_UP + 60_000;
const BOUND = NOW - CAUGHT_UP - REPLICA_LAG_AGE_MARGIN_MS;

function reader(
  id: string,
  lag: unknown,
  age: unknown = 0,
  extra: Record<string, unknown> = {}
) {
  return {
    server_id: id,
    session_id: `session-${id}`,
    lag_ms: lag,
    age_ms: age,
    now_ms: NOW,
    ...extra
  };
}

const writer = {
  server_id: 'w',
  session_id: 'MASTER_SESSION_ID',
  lag_ms: null,
  age_ms: 3_600_000,
  now_ms: NOW
};

function lagSource(rows: unknown[] | Error) {
  return jest.fn(async (_sql: string) => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
}

function check(rows: unknown[] | Error, now = NOW) {
  const log: string[] = [];
  const readRows = lagSource(rows);
  const result = checkReplicaLag({
    caughtUpMs: CAUGHT_UP,
    readRows,
    now: () => now,
    log: (message) => log.push(message)
  });
  return { result, readRows, log };
}

describe('checkReplicaLag', () => {
  it('reads every row of replica_host_status, the writer told apart', async () => {
    const { result, readRows } = check([reader('r1', 10)]);
    await result;
    expect(readRows).toHaveBeenCalledWith(ALL_READERS_LAG_SQL);
    expect(ALL_READERS_LAG_SQL).toContain(
      'FROM information_schema.replica_host_status'
    );
    expect(ALL_READERS_LAG_SQL).not.toContain('WHERE');
    expect(ALL_READERS_LAG_SQL).toContain('SESSION_ID AS session_id');
  });

  it('runs when the worst lag plus its age is just under the bound', async () => {
    expect(BOUND).toBe(58_500);
    await expect(check([reader('r1', BOUND - 1)]).result).resolves.toEqual({
      checked_by: 'export',
      readers: 1,
      worst_lag_ms: BOUND - 1,
      worst_lag_age_ms: 0,
      read_at: new Date(NOW).toISOString()
    });
    await expect(
      check([reader('r1', BOUND - 1000.5, 999.5)]).result
    ).resolves.toMatchObject({ worst_lag_ms: 57_500, worst_lag_age_ms: 1000 });
  });

  it.each([
    ['equal to the bound', BOUND],
    ['over it', BOUND + 1],
    ['far over it', 600_000]
  ])('refuses when the worst lag is %s', async (_what, lag) => {
    const refusal = check([reader('r1', lag)]).result;
    await expect(refusal).rejects.toThrow(WavesExportUsageError);
    await expect(refusal).rejects.toThrow('The read replica may be up to');
    await expect(refusal).rejects.toMatchObject({ showHelp: false });
  });

  it('holds the reader furthest behind to the bound, over every reader', async () => {
    await expect(
      check([reader('r1', 10), reader('r2', BOUND), reader('r3', 5)]).result
    ).rejects.toThrow('the largest lag over its 3 readers is 58.5 s');
    await expect(
      check([
        reader('r1', 10, 2),
        reader('r2', 30_000, 2_000),
        reader('r3', 31_000)
      ]).result
    ).resolves.toMatchObject({
      readers: 3,
      worst_lag_ms: 30_000,
      worst_lag_age_ms: 2_000
    });
  });

  it("leaves the writer's row out", async () => {
    await expect(
      check([writer, reader('r1', 10)]).result
    ).resolves.toMatchObject({ readers: 1, worst_lag_ms: 10 });
  });

  it("takes each reader's newest row, as the chain exports do", async () => {
    await expect(
      check([
        reader('r1', 0, 3_600_000),
        reader('r1', 50, 100),
        reader('r1', null, null),
        reader('r2', 20, 10)
      ]).result
    ).resolves.toMatchObject({
      readers: 2,
      worst_lag_ms: 50,
      worst_lag_age_ms: 100
    });
  });

  it("adds a stale row's age to its lag", async () => {
    // The same lag runs from a fresh row and refuses from a stale one.
    await expect(check([reader('r1', 1_000)]).result).resolves.toBeDefined();
    await expect(
      check([reader('r1', 1_000, BOUND - 1_000)]).result
    ).rejects.toThrow(
      'the largest lag over its one reader is 1.0 s, in a reading 57.5 s old'
    );
    // A stale reader decides over one with a larger lag on a fresh row.
    await expect(
      check([reader('r1', 1_000, 50_000), reader('r2', 20_000)]).result
    ).resolves.toMatchObject({ worst_lag_ms: 1_000, worst_lag_age_ms: 50_000 });
  });

  it('says a reading a minute old or more may never pass', async () => {
    const stale = check([reader('r1', 0, 60_000)], CAUGHT_UP + 30_000).result;
    await expect(stale).rejects.toThrow(
      'Try again after 00:06:02 UTC. If that reading is older still then, the reader has stopped updating it: read the largest lag over all readers another way (on Aurora, the AuroraReplicaLagMaximum metric) and, once that much time has passed since 00:05:00 UTC, run the export again with --replica-lag-checked-by <your name> --replica-lag-check-note <how you checked it>.'
    );
    await expect(
      check([reader('r1', 0, 59_999)], CAUGHT_UP + 30_000).result
    ).rejects.not.toThrow('older still');
  });

  it('reads a row up to a second ahead as age 0, which the margin covers', async () => {
    await expect(
      check([reader('r1', BOUND - 1, -999)]).result
    ).resolves.toMatchObject({ worst_lag_age_ms: 0 });
  });

  it("holds the bound on the server's clock when it is behind this one", async () => {
    const serverMs = NOW - 1_000;
    await expect(
      check([reader('r1', BOUND - 1, 0, { now_ms: serverMs })]).result
    ).rejects.toThrow('Try again after');
    await expect(
      check([reader('r1', BOUND - 1_001, 0, { now_ms: serverMs })]).result
    ).resolves.toMatchObject({ read_at: new Date(serverMs).toISOString() });
    // A server clock ahead of this one is not trusted further than this one.
    await expect(
      check([reader('r1', BOUND, 0, { now_ms: NOW + 60_000 })]).result
    ).rejects.toThrow('Try again after');
  });

  it.each<[string, unknown[] | Error, string]>([
    [
      'the table cannot be read',
      Object.assign(
        new Error("Unknown table 'replica_host_status' for 'user'@'host'"),
        { code: 'ER_UNKNOWN_TABLE', errno: 1109 }
      ),
      'reading information_schema.replica_host_status failed (ER_UNKNOWN_TABLE 1109)'
    ],
    [
      'the read times out',
      Object.assign(new Error('Query inactivity timeout'), {
        code: 'PROTOCOL_SEQUENCE_TIMEOUT'
      }),
      'failed (PROTOCOL_SEQUENCE_TIMEOUT)'
    ],
    [
      'the table has no rows',
      [],
      'replica_host_status has no row for any reader'
    ],
    [
      "the table has only the writer's row",
      [writer],
      'replica_host_status has no row for any reader'
    ],
    [
      "a reader's lag is missing",
      [reader('r1', 10), reader('r2', null)],
      'the row of one of its 2 readers says REPLICA_LAG_IN_MILLISECONDS is null'
    ],
    [
      "a reader's lag is negative",
      [reader('r1', -5)],
      'REPLICA_LAG_IN_MILLISECONDS is -5: not a lag'
    ],
    [
      "a reader's lag is not a number",
      [reader('r1', 'soon')],
      'REPLICA_LAG_IN_MILLISECONDS is soon: not a lag'
    ],
    [
      "a reader's row has no timestamp",
      [reader('r1', 10, null)],
      "LAST_UPDATE_TIMESTAMP is null: the row's age is unknown"
    ],
    [
      "a reader's row is dated ahead of UTC",
      [reader('r1', 10), reader('r2', 10, -3_600_000)],
      'LAST_UPDATE_TIMESTAMP is 3600000 ms ahead of UTC_TIMESTAMP'
    ],
    [
      "the server's clock is missing",
      [reader('r1', 10, 0, { now_ms: null })],
      "the server's clock could not be read"
    ]
  ])('refuses when %s', async (_case, rows, reason) => {
    const { result, log } = check(rows);
    await expect(result).rejects.toThrow(WavesExportUsageError);
    await expect(result).rejects.toThrow(
      "The export can't tell how far the read replica is behind"
    );
    await expect(result).rejects.toThrow(reason);
    await expect(result).rejects.toThrow(
      '--replica-lag-checked-by <your name> --replica-lag-check-note <how you checked it>'
    );
    if (rows instanceof Error) {
      // The server's message, which can name the user and host, is logged only.
      await expect(result).rejects.not.toThrow(rows.message);
      expect(log.join('\n')).toContain(rows.message);
    }
  });

  it('names how far behind, the reader count and when to try again', async () => {
    const { result } = check(
      [reader('r1', 9_500, 2_000), reader('r2', 100)],
      CAUGHT_UP + 10_000
    );
    await expect(result).rejects.toThrow(
      'The read replica may be up to 13.0 s behind: the largest lag over its 2 readers is 9.5 s, in a reading 2.0 s old, plus 1.5 s for clock and timestamp rounding. The export needs every reader caught up past 00:05:00 UTC, five minutes after the freeze. Try again after 00:05:13 UTC.'
    );
  });

  it('says why an unknown lag refuses and what a person can do', async () => {
    await expect(check([]).result).rejects.toThrow(
      "The export can't tell how far the read replica is behind: information_schema.replica_host_status has no row for any reader. It needs every reader caught up past 00:05:00 UTC, five minutes after the freeze. If you can, read the largest lag over all readers another way (on Aurora, the AuroraReplicaLagMaximum metric) and, once that much time has passed since 00:05:00 UTC, run the export again with --replica-lag-checked-by <your name> --replica-lag-check-note <how you checked it>."
    );
  });
});

describe('replicaLagAtStart', () => {
  it('checks the lag and returns what export.json records', async () => {
    const log: string[] = [];
    const readRows = lagSource([writer, reader('r1', 40, 5), reader('r2', 7)]);
    await expect(
      replicaLagAtStart({
        caughtUpMs: CAUGHT_UP,
        checkedByPerson: null,
        readRows,
        now: () => NOW,
        log: (message) => log.push(message)
      })
    ).resolves.toEqual({
      checked_by: 'export',
      readers: 2,
      worst_lag_ms: 40,
      worst_lag_age_ms: 5,
      read_at: new Date(NOW).toISOString()
    });
    expect(readRows).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      'read replica: the largest lag over its 2 readers is 40 ms, in a reading 5 ms old; every reader has caught up past 00:05:00 UTC'
    ]);
  });

  it("runs on a person's word without reading the lag, names them loudly and records both", async () => {
    const log: string[] = [];
    const readRows = lagSource(new Error('not to be read'));
    await expect(
      replicaLagAtStart({
        caughtUpMs: CAUGHT_UP,
        checkedByPerson: {
          person: 'the operator',
          note: 'AuroraReplicaLagMaximum read at 00:06 UTC: 20 ms'
        },
        readRows,
        now: () => CAUGHT_UP,
        log: (message) => log.push(message)
      })
    ).resolves.toEqual({
      checked_by: 'person',
      person: 'the operator',
      note: 'AuroraReplicaLagMaximum read at 00:06 UTC: 20 ms'
    });
    expect(readRows).not.toHaveBeenCalled();
    expect(log).toEqual([
      `WARNING: the export does not check the read replica's lag. It takes the word of "the operator" that every reader has caught up past 00:05:00 UTC, checked this way: "AuroraReplicaLagMaximum read at 00:06 UTC: 20 ms". export.json records both.`
    ]);
  });
});

describe('a rehearsal', () => {
  function rehearse(readRows: (sql: string) => Promise<unknown[]>) {
    const log: string[] = [];
    const result = replicaLagAtStart({
      caughtUpMs: null,
      checkedByPerson: null,
      readRows,
      now: () => NOW,
      log: (message) => log.push(message)
    });
    return { result, log };
  }

  it('reads and reports the lag, held to no bound', async () => {
    const readRows = lagSource([
      writer,
      reader('r1', 600_000, 2.5),
      reader('r2', 7)
    ]);
    const { result, log } = rehearse(readRows);
    await expect(result).resolves.toEqual({
      checked_by: 'rehearsal',
      readers: 2,
      worst_lag_ms: 600_000,
      worst_lag_age_ms: 3,
      read_at: new Date(NOW).toISOString(),
      unknown_reason: null
    });
    expect(readRows).toHaveBeenCalledWith(ALL_READERS_LAG_SQL);
    expect(log).toEqual([
      'rehearsal: the largest lag over its 2 readers is 600000 ms, in a reading 3 ms old (a rehearsal holds it to no bound)'
    ]);
  });

  it('records a lag it cannot know, never refusing', async () => {
    const { result, log } = rehearse(
      lagSource([reader('r1', 10), reader('r2', null)])
    );
    await expect(result).resolves.toEqual({
      checked_by: 'rehearsal',
      readers: 2,
      worst_lag_ms: null,
      worst_lag_age_ms: null,
      read_at: new Date(NOW).toISOString(),
      unknown_reason:
        'the row of one of its 2 readers says REPLICA_LAG_IN_MILLISECONDS is null'
    });
    expect(log).toEqual([
      "rehearsal: the read replica's lag can't be read: the row of one of its 2 readers says REPLICA_LAG_IN_MILLISECONDS is null. A run after the freeze would refuse on this."
    ]);
  });

  it('logs and records a query error, never fatal', async () => {
    const failure = Object.assign(
      new Error("Unknown table 'replica_host_status' for 'user'@'host'"),
      { code: 'ER_UNKNOWN_TABLE', errno: 1109 }
    );
    const { result, log } = rehearse(lagSource(failure));
    await expect(result).resolves.toMatchObject({
      checked_by: 'rehearsal',
      readers: null,
      worst_lag_ms: null,
      unknown_reason:
        'reading information_schema.replica_host_status failed (ER_UNKNOWN_TABLE 1109)'
    });
    expect(log[0]).toContain(failure.message);
    // A result the reading can't use at all is recorded too.
    await expect(
      rehearse(async () => null as never).result
    ).resolves.toMatchObject({
      checked_by: 'rehearsal',
      unknown_reason: expect.stringContaining('failed (TypeError)')
    });
  });
});
