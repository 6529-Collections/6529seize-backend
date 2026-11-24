import { REPLICA_LAG_AGE_MARGIN_MS } from '@/dbDumpsDaily/chain-exports/replica-snapshot';
import { ReplicaLagCheckedBy, WavesExportUsageError } from './cli-options';
import {
  ALL_READERS_LAG_SQL,
  checkReplicaLag,
  HostSetting,
  INNODB_READ_ONLY_SQL,
  READ_ONLY_SQL,
  replicaLagAtStart
} from './waves-export.replica-lag';

const T_W = Date.UTC(2026, 10, 25, 0, 0, 0);
/** Five minutes after the freeze: every reader must be past it. */
const CAUGHT_UP = T_W + 5 * 60 * 1000;
/** A minute later: a reader may be up to 60 s behind, margin included. */
const NOW = CAUGHT_UP + 60_000;
const BOUND = NOW - CAUGHT_UP - REPLICA_LAG_AGE_MARGIN_MS;
const PERSON: ReplicaLagCheckedBy = {
  person: 'the operator',
  note: 'AuroraReplicaLagMaximum read at 00:06 UTC: 20 ms'
};
const PERSON_STEP =
  "read the largest lag over all readers (on Aurora, the AuroraReplicaLagMaximum metric) and make sure DB_HOST is the cluster's reader endpoint. Once that much lag has passed since 00:05:00 UTC, run the export again with --replica-lag-checked-by <your name> --replica-lag-check-note <what you read, its value and when>.";

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

interface Server {
  readonly lag: unknown[] | Error;
  /** @@GLOBAL.read_only (an Aurora reader's is 0) or its error. */
  readonly ro?: unknown;
  /** @@GLOBAL.innodb_read_only (an Aurora reader's is 1) or its error. */
  readonly iro?: unknown;
}

/** A fake DB_HOST: answers the check's three queries. */
function serverSource({ lag, ro = 0, iro = 1 }: Server) {
  const answer = (value: unknown, row: (it: unknown) => unknown) => {
    if (value instanceof Error) throw value;
    return [row(value)];
  };
  return jest.fn(async (sql: string): Promise<unknown[]> => {
    if (sql === READ_ONLY_SQL) return answer(ro, (it) => ({ ro: it }));
    if (sql === INNODB_READ_ONLY_SQL) return answer(iro, (it) => ({ iro: it }));
    if (sql === ALL_READERS_LAG_SQL) {
      if (lag instanceof Error) throw lag;
      return lag;
    }
    throw new Error(`unexpected query ${sql}`);
  });
}

function check(
  lag: unknown[] | Error,
  {
    now = NOW,
    person = null,
    hostSetting = undefined,
    ...server
  }: Omit<Server, 'lag'> & {
    now?: number;
    person?: ReplicaLagCheckedBy | null;
    hostSetting?: HostSetting;
  } = {}
) {
  const log: string[] = [];
  const readRows = serverSource({ lag, ...server });
  const result = checkReplicaLag({
    caughtUpMs: CAUGHT_UP,
    checkedByPerson: person,
    onOneConnection: (work) => work(readRows),
    hostSetting,
    now: () => now,
    log: (message) => log.push(message)
  });
  return { result, readRows, log };
}

const failure = (message: string, code: string, errno?: number) =>
  Object.assign(new Error(message), errno ? { code, errno } : { code });

describe('checkReplicaLag', () => {
  it("reads DB_HOST's read-only state and every row of replica_host_status", async () => {
    const { result, readRows } = check([reader('r1', 10)]);
    await result;
    expect(readRows.mock.calls.map(([sql]) => sql)).toEqual([
      READ_ONLY_SQL,
      INNODB_READ_ONLY_SQL,
      ALL_READERS_LAG_SQL
    ]);
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
      read_at: new Date(NOW).toISOString(),
      server_read_only: true,
      readers: 1,
      worst_lag_ms: BOUND - 1,
      worst_lag_age_ms: 0,
      stale_readers: 0,
      unknown_reason: null
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

  it('holds the reader furthest behind (lag plus age) to the bound, and names it so', async () => {
    const rows = [
      reader('r1', 10, 2),
      reader('r2', 30_000, 2_000),
      reader('r3', 31_000)
    ];
    const passing = check(rows);
    await expect(passing.result).resolves.toMatchObject({
      readers: 3,
      worst_lag_ms: 30_000,
      worst_lag_age_ms: 2_000
    });
    expect(passing.log).toEqual([
      "read replica: DB_HOST's server is read-only; of its 3 readers, the one furthest behind has a lag of 30000 ms, in a reading 2000 ms old; every reader has caught up past 00:05:00 UTC"
    ]);
    const refusal = check(rows, { now: CAUGHT_UP + 20_000 }).result;
    await expect(refusal).rejects.toThrow(
      'of its 3 readers, the one furthest behind has a lag of 30.0 s, in a reading 2.0 s old'
    );
    await expect(refusal).rejects.not.toThrow('largest lag');
  });

  it("leaves out every row of the current writer's server, a failover leftover too", async () => {
    const leftover = {
      server_id: 'w',
      session_id: 'old-reader-session',
      lag_ms: 0,
      age_ms: 600_000,
      now_ms: NOW
    };
    await expect(
      check([leftover, writer, reader('r1', 10)]).result
    ).resolves.toMatchObject({ readers: 1, worst_lag_ms: 10 });
  });

  it('checks an old writer that now serves as a reader', async () => {
    // After a failover: B writes now; A's writer row is old, and A reads.
    const writerRow = (server: string, age: number) => ({
      server_id: server,
      session_id: 'MASTER_SESSION_ID',
      lag_ms: 0,
      age_ms: age,
      now_ms: NOW
    });
    // The old writer row comes first: the newest one decides, not the first.
    const rows = [
      writerRow('A', 900_000),
      writerRow('B', 5),
      reader('A', 40_000),
      reader('C', 10)
    ];
    const refusal = check(rows, { now: CAUGHT_UP + 30_000 }).result;
    await expect(refusal).rejects.toThrow(
      'The read replica may be up to 41.5 s behind: of its 2 readers, the one furthest behind has a lag of 40.0 s'
    );
    // Not yet come back as a reader: its old writer row can't be told.
    await expect(
      check([writerRow('A', 900_000), writerRow('B', 5), reader('C', 10)])
        .result
    ).rejects.toThrow(
      "the row of one of its 2 readers stopped updating 900.0 s ago, so its lag can't be known"
    );
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

  it("adds a row's age to its lag", async () => {
    // The same lag runs from a fresh row and refuses from an older one.
    await expect(check([reader('r1', 1_000)]).result).resolves.toBeDefined();
    await expect(
      check([reader('r1', 1_000, BOUND - 1_000)]).result
    ).rejects.toThrow(
      'its one reader has a lag of 1.0 s, in a reading 57.5 s old'
    );
    // An older row decides over a larger lag on a fresh one.
    await expect(
      check([reader('r1', 1_000, 50_000), reader('r2', 20_000)]).result
    ).resolves.toMatchObject({ worst_lag_ms: 1_000, worst_lag_age_ms: 50_000 });
  });

  it("can't tell, and names no retry time, when only a row that stopped updating blocks", async () => {
    const refusal = check([reader('r1', 0, 60_000), reader('r2', 10)], {
      now: CAUGHT_UP + 30_000
    }).result;
    await expect(refusal).rejects.toThrow(
      "The export can't tell whether every reader has caught up past 00:05:00 UTC, five minutes after the freeze: the row of one of its 2 readers stopped updating 60.0 s ago, so its lag can't be known. Run it once more first"
    );
    await expect(refusal).rejects.not.toThrow('Try again after');
    // A row a minute old that doesn't reach the bound blocks nothing.
    await expect(
      check([reader('r1', 0, 120_000, { now_ms: CAUGHT_UP + 300_000 })], {
        now: CAUGHT_UP + 300_000
      }).result
    ).resolves.toMatchObject({ checked_by: 'export', stale_readers: 1 });
    // A fresh row past the bound still decides: wait.
    await expect(
      check([reader('r1', 0, 60_000), reader('r2', 40_000)], {
        now: CAUGHT_UP + 30_000
      }).result
    ).rejects.toThrow(
      "of its 2 readers, the one furthest behind on an up-to-date row has a lag of 40.0 s, in a reading 0.0 s old, and 1.5 s more covers clock and timestamp rounding. The export needs every reader caught up past 00:05:00 UTC, five minutes after the freeze. Try again after 00:05:42 UTC. Another reader's row stopped updating, so then it may say it can't tell instead: follow what it says there."
    );
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

  it('gives the retry date when it is not the same day', async () => {
    await expect(
      check([reader('r1', 24 * 3_600_000)], { now: CAUGHT_UP + 10_000 }).result
    ).rejects.toThrow('Try again after 2026-11-26 00:05:02 UTC.');
  });

  it.each<[string, unknown[] | Error, string]>([
    [
      'the table cannot be read',
      failure(
        "Unknown table 'replica_host_status' for 'user'@'host'",
        'ER_UNKNOWN_TABLE',
        1109
      ),
      'reading information_schema.replica_host_status failed (ER_UNKNOWN_TABLE 1109)'
    ],
    [
      'the read times out',
      failure('Query inactivity timeout', 'PROTOCOL_SEQUENCE_TIMEOUT'),
      'failed (PROTOCOL_SEQUENCE_TIMEOUT)'
    ],
    [
      'the table has no rows',
      [],
      'replica_host_status has no row for any reader'
    ],
    [
      "the table has only the writer's rows",
      [writer, { ...writer, session_id: 'old' }],
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
      'the row of its one reader says REPLICA_LAG_IN_MILLISECONDS is -5: not a lag'
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
  ])("can't tell, and refuses, when %s", async (_case, rows, reason) => {
    const { result, log } = check(rows);
    await expect(result).rejects.toThrow(WavesExportUsageError);
    await expect(result).rejects.toThrow(
      "The export can't tell whether every reader has caught up past 00:05:00 UTC"
    );
    await expect(result).rejects.toThrow(reason);
    // A passing error clears: once more first, then a person's check.
    await expect(result).rejects.toThrow(
      `Run it once more first: a passing error or a late row update can clear. If it says the same again, check it another way: ${PERSON_STEP}`
    );
    if (rows instanceof Error) {
      // The server's message, which can name the user and host, is logged only.
      await expect(result).rejects.not.toThrow(rows.message);
      expect(log.join('\n')).toContain(rows.message);
    }
  });

  describe("DB_HOST's server", () => {
    it('refuses one that is not read-only, whatever a person says', async () => {
      for (const person of [null, PERSON]) {
        const { result, log } = check([reader('r1', 10)], {
          ro: 0,
          iro: 0,
          person
        });
        await expect(result).rejects.toThrow(
          "DB_HOST's server is not read-only (read_only and innodb_read_only are both off), so it is not a read replica, and the export reads only from one. Point DB_HOST at the cluster's reader endpoint, with DB_USER and DB_PASS for it: the export reads through DB_HOST, not DB_HOST_READ."
        );
        expect(log).toEqual([]);
      }
    });

    it.each([
      ['read_only on', { ro: 1, iro: 0 }],
      ['innodb_read_only on (an Aurora reader)', { ro: 0, iro: 1 }],
      ['read_only on, innodb_read_only unreadable', { ro: 1, iro: new Error() }]
    ])('takes %s as read-only', async (_case, state) => {
      await expect(
        check([reader('r1', 10)], state).result
      ).resolves.toMatchObject({ server_read_only: true });
    });

    it.each([
      [
        'read_only cannot be read',
        { ro: failure('denied', 'ER_SPECIFIC_ACCESS_DENIED_ERROR', 1227) },
        'reading @@GLOBAL.read_only failed (ER_SPECIFIC_ACCESS_DENIED_ERROR 1227)'
      ],
      [
        'read_only is off and innodb_read_only unreadable',
        { ro: 0, iro: new Error('no such variable') },
        "DB_HOST's server did not say whether it is read-only"
      ]
    ])("can't tell when %s", async (_case, state, reason) => {
      const { result } = check([reader('r1', 10)], state);
      await expect(result).rejects.toThrow(
        `The export can't tell whether every reader has caught up past 00:05:00 UTC, five minutes after the freeze: ${reason}. Run it once more first`
      );
    });
  });

  it('names how far behind, the reader furthest behind and when to try again', async () => {
    const { result } = check([reader('r1', 9_500, 2_000), reader('r2', 100)], {
      now: CAUGHT_UP + 10_000
    });
    await expect(result).rejects.toThrow(
      'The read replica may be up to 13.0 s behind: of its 2 readers, the one furthest behind has a lag of 9.5 s, in a reading 2.0 s old, and 1.5 s more covers clock and timestamp rounding. The export needs every reader caught up past 00:05:00 UTC, five minutes after the freeze. Try again after 00:05:13 UTC.'
    );
  });

  it("says why it can't tell and what a person can do", async () => {
    await expect(check([]).result).rejects.toThrow(
      `The export can't tell whether every reader has caught up past 00:05:00 UTC, five minutes after the freeze: information_schema.replica_host_status has no row for any reader. Run it once more first: a passing error or a late row update can clear. If it says the same again, check it another way: ${PERSON_STEP}`
    );
  });
});

describe("a person's check", () => {
  it("is taken when the export can't tell, and recorded with what it read", async () => {
    const { result, readRows, log } = check(
      [reader('r1', 10), reader('r2', null)],
      { person: PERSON }
    );
    await expect(result).resolves.toEqual({
      checked_by: 'person',
      person: 'the operator',
      note: 'AuroraReplicaLagMaximum read at 00:06 UTC: 20 ms',
      read_at: new Date(NOW).toISOString(),
      server_read_only: true,
      readers: 2,
      worst_lag_ms: null,
      worst_lag_age_ms: null,
      stale_readers: null,
      unknown_reason:
        'the row of one of its 2 readers says REPLICA_LAG_IN_MILLISECONDS is null'
    });
    expect(readRows).toHaveBeenCalledWith(ALL_READERS_LAG_SQL);
    expect(log).toEqual([
      `WARNING: the export can't tell whether every reader has caught up past 00:05:00 UTC, five minutes after the freeze: the row of one of its 2 readers says REPLICA_LAG_IN_MILLISECONDS is null. It goes ahead on the word of "the operator", who checked it this way: "AuroraReplicaLagMaximum read at 00:06 UTC: 20 ms". export.json records both, with what the export read.`
    ]);
  });

  it('is taken for a row that stopped updating, with its lag recorded', async () => {
    await expect(
      check([reader('r1', 5, 3 * 86_400_000), reader('r2', 10)], {
        person: PERSON
      }).result
    ).resolves.toMatchObject({
      checked_by: 'person',
      readers: 2,
      worst_lag_ms: 5,
      worst_lag_age_ms: 3 * 86_400_000,
      stale_readers: 1,
      unknown_reason:
        "the row of one of its 2 readers stopped updating 259200.0 s ago, so its lag can't be known"
    });
  });

  it("is taken when DB_HOST's read-only state can't be read", async () => {
    await expect(
      check([reader('r1', 10)], { ro: new Error('gone'), person: PERSON })
        .result
    ).resolves.toMatchObject({
      checked_by: 'person',
      server_read_only: null,
      worst_lag_ms: 10
    });
  });

  it('is refused over a lag the export can read: the person waits', async () => {
    const { result } = check([reader('r1', 600_000)], { person: PERSON });
    await expect(result).rejects.toThrow('Try again after 00:15:02 UTC.');
    await expect(result).rejects.toThrow(
      "A person's check can't stand in for a lag the export can read: wait until then, and run it without --replica-lag-checked-by and --replica-lag-check-note."
    );
  });

  it('is refused when every reader has caught up', async () => {
    await expect(
      check([reader('r1', 10)], { person: PERSON }).result
    ).rejects.toThrow(
      "The export can read the lag, and every reader has caught up past 00:05:00 UTC, five minutes after the freeze: run it without --replica-lag-checked-by and --replica-lag-check-note, which are only for when it can't tell."
    );
  });
});

describe('a rehearsal', () => {
  function rehearse(server: Server) {
    const log: string[] = [];
    const readRows = serverSource(server);
    const result = replicaLagAtStart({
      caughtUpMs: null,
      checkedByPerson: null,
      onOneConnection: (work) => work(readRows),
      now: () => NOW,
      log: (message) => log.push(message)
    });
    return { result, log, readRows };
  }

  it('reads and reports the lag, held to no bound', async () => {
    const { result, log } = rehearse({
      lag: [writer, reader('r1', 600_000, 2.5), reader('r2', 7)]
    });
    await expect(result).resolves.toEqual({
      checked_by: 'rehearsal',
      read_at: new Date(NOW).toISOString(),
      server_read_only: true,
      readers: 2,
      worst_lag_ms: 600_000,
      worst_lag_age_ms: 3,
      stale_readers: 0,
      unknown_reason: null
    });
    expect(log).toEqual([
      'rehearsal: of its 2 readers, the one furthest behind has a lag of 600000 ms, in a reading 3 ms old (a rehearsal holds it to no bound)'
    ]);
  });

  it('records a lag it cannot know, never refusing', async () => {
    const { result, log } = rehearse({
      lag: [reader('r1', 10), reader('r2', null)]
    });
    await expect(result).resolves.toMatchObject({
      checked_by: 'rehearsal',
      readers: 2,
      worst_lag_ms: null,
      unknown_reason:
        'the row of one of its 2 readers says REPLICA_LAG_IN_MILLISECONDS is null'
    });
    expect(log).toEqual([
      "rehearsal: the export can't tell: the row of one of its 2 readers says REPLICA_LAG_IN_MILLISECONDS is null. A run after the freeze would refuse on this unless a person checks it another way."
    ]);
  });

  it('warns of a reader whose row stopped updating', async () => {
    const { result, log } = rehearse({
      lag: [reader('r1', 5, 3 * 86_400_000), reader('r2', 10)]
    });
    await expect(result).resolves.toMatchObject({
      stale_readers: 1,
      worst_lag_age_ms: 3 * 86_400_000,
      unknown_reason: null
    });
    expect(log[1]).toBe(
      "rehearsal: 1 of its 2 readers' rows are a minute old or more (the oldest 259200000 ms): such a reader may have stopped updating its row, and a run after the freeze may refuse on it unless a person checks it another way."
    );
  });

  it("records and warns of a DB_HOST that isn't read-only", async () => {
    const { result, log } = rehearse({ lag: [reader('r1', 0)], ro: 0, iro: 0 });
    await expect(result).resolves.toMatchObject({
      checked_by: 'rehearsal',
      server_read_only: false
    });
    expect(log[0]).toBe(
      "rehearsal: DB_HOST's server is not read-only, so it is not a read replica: a run after the freeze would refuse on this. Point DB_HOST at the cluster's reader endpoint, with DB_USER and DB_PASS for it: the export reads through DB_HOST, not DB_HOST_READ."
    );
  });

  it('logs and records a query error, never fatal', async () => {
    const error = failure(
      "Unknown table 'replica_host_status' for 'user'@'host'",
      'ER_UNKNOWN_TABLE',
      1109
    );
    const { result, log } = rehearse({ lag: error, ro: error });
    await expect(result).resolves.toMatchObject({
      checked_by: 'rehearsal',
      server_read_only: null,
      readers: null,
      worst_lag_ms: null,
      unknown_reason:
        'reading @@GLOBAL.read_only failed (ER_UNKNOWN_TABLE 1109); reading information_schema.replica_host_status failed (ER_UNKNOWN_TABLE 1109)'
    });
    expect(log[0]).toContain(error.message);
    // A result the reading can't use is recorded too, read-only state kept.
    await expect(
      rehearse({ lag: null as never }).result
    ).resolves.toMatchObject({
      checked_by: 'rehearsal',
      server_read_only: true,
      unknown_reason:
        'reading information_schema.replica_host_status gave no rows'
    });
  });
});

describe('one connection', () => {
  it("runs the check's three queries on the one it is given", async () => {
    const readRows = serverSource({ lag: [reader('r1', 10)] });
    const connections: string[] = [];
    let opened = 0;
    await checkReplicaLag({
      caughtUpMs: CAUGHT_UP,
      onOneConnection: async (work) => {
        const id = `connection-${++opened}`;
        return work(async (sql) => {
          connections.push(id);
          return readRows(sql);
        });
      },
      now: () => NOW,
      log: () => undefined
    });
    expect(opened).toBe(1);
    expect(connections).toEqual([
      'connection-1',
      'connection-1',
      'connection-1'
    ]);
  });

  it("keeps what it read when ending the connection fails, and can't tell when it fails first", async () => {
    const readRows = serverSource({ lag: [reader('r1', 10)] });
    await expect(
      checkReplicaLag({
        caughtUpMs: CAUGHT_UP,
        onOneConnection: async (work) => {
          await work(readRows);
          throw failure('commit failed', 'PROTOCOL_CONNECTION_LOST');
        },
        now: () => NOW,
        log: () => undefined
      })
    ).resolves.toMatchObject({ checked_by: 'export', worst_lag_ms: 10 });
    const log: string[] = [];
    await expect(
      checkReplicaLag({
        caughtUpMs: CAUGHT_UP,
        onOneConnection: async () => {
          throw failure("connect failed for 'user'@'host'", 'ECONNREFUSED');
        },
        now: () => NOW,
        log: (message) => log.push(message)
      })
    ).rejects.toThrow(
      "can't tell whether every reader has caught up past 00:05:00 UTC, five minutes after the freeze: reading DB_HOST's read-only state failed (ECONNREFUSED); reading information_schema.replica_host_status failed (ECONNREFUSED)."
    );
    expect(log.join('\n')).toContain("connect failed for 'user'@'host'");
  });
});

describe('in IAM mode', () => {
  it('names DB_IAM_HOST, which the export then reads through', async () => {
    const { result } = check([reader('r1', 10)], {
      ro: 0,
      iro: 0,
      hostSetting: 'DB_IAM_HOST'
    });
    await expect(result).rejects.toThrow(
      "DB_IAM_HOST's server is not read-only (read_only and innodb_read_only are both off), so it is not a read replica, and the export reads only from one. Point DB_IAM_HOST at a read-only endpoint, with DB_IAM_USER for it: with DB_IAM_AUTH=true the export reads through DB_IAM_HOST, not DB_HOST or DB_IAM_HOST_READ."
    );
    await expect(
      check([], { hostSetting: 'DB_IAM_HOST' }).result
    ).rejects.toThrow('make sure DB_IAM_HOST is a read-only endpoint.');
  });
});

describe('in the waves export job', () => {
  it("names the function's DB_HOST_READ, which the job reads through, and never says to move DB_HOST", async () => {
    const { result } = check([reader('r1', 10)], {
      ro: 0,
      iro: 0,
      hostSetting: 'DB_HOST_READ'
    });
    await expect(result).rejects.toThrow(
      "DB_HOST_READ's server is not read-only (read_only and innodb_read_only are both off), so it is not a read replica, and the export reads only from one. Point the function's DB_HOST_READ at the cluster's reader endpoint, with DB_USER_READ and DB_PASS_READ for it: the waves export job reads through DB_HOST_READ, and never changes DB_HOST."
    );
    await expect(
      check([], { hostSetting: 'DB_HOST_READ' }).result
    ).rejects.toThrow(
      "make sure DB_HOST_READ is the cluster's reader endpoint."
    );
  });

  it('names DB_IAM_HOST_READ in IAM mode', async () => {
    const { result } = check([reader('r1', 10)], {
      ro: 0,
      iro: 0,
      hostSetting: 'DB_IAM_HOST_READ'
    });
    await expect(result).rejects.toThrow(
      "DB_IAM_HOST_READ's server is not read-only (read_only and innodb_read_only are both off), so it is not a read replica, and the export reads only from one. Point the function's DB_IAM_HOST_READ at a read-only endpoint, with DB_IAM_USER_READ for it: the waves export job reads through DB_IAM_HOST_READ, and never changes DB_IAM_HOST."
    );
    await expect(
      check([], { hostSetting: 'DB_IAM_HOST_READ' }).result
    ).rejects.toThrow('make sure DB_IAM_HOST_READ is a read-only endpoint.');
  });
});
