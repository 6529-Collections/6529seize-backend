jest.mock('@/priority-alerts.context', () => ({
  sendPriorityAlertIfConfigured: jest.fn().mockResolvedValue(undefined)
}));

import { MEMES_CONTRACT } from '@/constants';
import { Logger } from '@/logging';
import { sendPriorityAlertIfConfigured } from '@/priority-alerts.context';
import type { MintStateWriter } from './mint-log-apply';
import type { MintStateReader } from './mint-log-capture';
import { applyEffectsToState, emptyCardState } from './mint-log-diff';
import type { MintLogHead, MintLogHeadDb } from './mint-log-head.db';
import {
  adminRecordBody,
  MINT_ADMIN_RECORD_TYPE,
  MINT_USER_RECORD_TYPE
} from './mint-log-intent';
import type {
  MintLogPorts,
  MintRecordLogEntry,
  MintSignedRecordsPort
} from './mint-log-ports';
import {
  entrySha256,
  InvalidSignedRecordException,
  MintLogRecorder,
  MintLogUnavailableException,
  MintWriteSpec
} from './mint-log-recorder';
import {
  MINT_KIND_PARTS,
  type MintCardEffects,
  type MintCardState,
  type MintLogEntryBody
} from './mint-log.types';

const ADMIN = '0x0000000000000000000000000000000000000001';
const CARD = {
  contract: '0x0000000000000000000000000000000000000abc',
  card_id: 100
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * An in-memory stand-in for the database: the card's rows, the log head and
 * the record log's queue. A failed transaction rolls back the head and the
 * queue; the writer commits on its own, as the real writers do.
 */
class Fake {
  state: MintCardState = emptyCardState();
  head: MintLogHead = { seq: -1, hash: null };
  queue: MintRecordLogEntry[] = [];
  savepoint: MintCardState | null = null;
  failAppends = 0;
  failLocks = 0;
  applyBug = false;

  readonly db = () =>
    ({
      executeNativeQueriesInTransaction: async (
        fn: (connection: unknown) => Promise<unknown>
      ) => {
        const head = this.head;
        const queued = this.queue.length;
        try {
          return await fn({ connection: 'tx' });
        } catch (error) {
          this.head = head;
          this.queue = this.queue.slice(0, queued);
          throw error;
        }
      },
      execute: async (sql: string) => {
        if (sql.startsWith('SAVEPOINT')) this.savepoint = clone(this.state);
        if (sql.startsWith('ROLLBACK TO SAVEPOINT')) {
          this.state = this.savepoint!;
        }
        return [];
      }
    }) as any;

  readonly reader = {
    capture: async () => clone(this.state)
  } as unknown as MintStateReader;

  readonly writer = {
    apply: async (_card: unknown, effects: MintCardEffects) => {
      this.state = applyEffectsToState(this.state, effects);
      if (this.applyBug) {
        this.state = { ...this.state, distribution: [] };
      }
    }
  } as unknown as MintStateWriter;

  readonly headDb = {
    lock: async () => {
      if (this.failLocks > 0) {
        this.failLocks--;
        throw Object.assign(new Error('Lock wait timeout exceeded'), {
          code: 'ER_LOCK_WAIT_TIMEOUT'
        });
      }
      return { ...this.head };
    },
    advance: async (next: MintLogHead) => {
      this.head = next;
    }
  } as unknown as MintLogHeadDb;

  readonly log = {
    append: jest.fn(async (entries: readonly MintRecordLogEntry[]) => {
      if (this.failAppends > 0) {
        this.failAppends--;
        throw new Error('append failed');
      }
      this.queue.push(...entries);
    })
  };

  entries(): MintLogEntryBody[] {
    return this.queue
      .filter((entry) => entry.t === 'entry')
      .map((entry) => (entry as { body: unknown }).body as MintLogEntryBody);
  }

  addRow(id: number, count = 1): void {
    this.state = applyEffectsToState(this.state, {
      distribution: {
        upsert: [{ id, wallet: `0x${id}`, count }],
        delete: []
      }
    });
  }
}

const records: MintSignedRecordsPort = {
  decodeHeader: (value) => JSON.parse(value),
  verify: async (event: any) =>
    event.valid
      ? {
          ok: true,
          record: {
            eventId: event.id,
            author: event.author,
            refs: event.refs,
            body: event.body,
            event
          }
        }
      : { ok: false, reason: 'sig', detail: 'bad signature' },
  grantProof: async () => ({ grant: 'proof' })
};

function recorder(
  fake: Fake,
  flags: { shadow?: boolean; primary?: boolean; replay?: boolean },
  ports: Partial<MintLogPorts> = {}
): MintLogRecorder {
  return new MintLogRecorder(
    {
      isMintLogShadowEnabled: () => !!flags.shadow,
      isMintLogPrimaryEnabled: () => !!flags.primary,
      isMintLogReplayCheckEnabled: () => !!flags.replay
    },
    () => ({ records, log: fake.log, ...ports }),
    fake.db,
    fake.reader,
    fake.writer,
    fake.headDb
  );
}

const intent = {
  route: 'POST /distributions/:contract/:id/artist-airdrops',
  params: { contract: CARD.contract, id: '100' },
  body: { csv: 'x' }
};

function spec(overrides: Partial<MintWriteSpec> = {}): MintWriteSpec {
  return {
    kind: 'dist.airdrops',
    card: CARD,
    actor: { type: 'admin', wallet: ADMIN, authority: 'env:TEST' },
    intent,
    signedRecords: null,
    ...overrides
  };
}

function header(
  valid = true,
  body: unknown = adminRecordBody('dist.airdrops', intent)
) {
  return JSON.stringify([
    {
      id: '0x' + 'e'.repeat(64),
      author: ADMIN,
      refs: [MINT_ADMIN_RECORD_TYPE, 'request-1'],
      body,
      valid
    }
  ]);
}

describe('MintLogRecorder', () => {
  beforeEach(() => jest.clearAllMocks());

  it('only runs the writer when both flags are off', async () => {
    const fake = new Fake();
    const capture = jest.spyOn(fake.reader, 'capture');
    await expect(
      recorder(fake, {}).write(spec(), async () => 'done')
    ).resolves.toBe('done');
    expect(capture).not.toHaveBeenCalled();
    expect(fake.log.append).not.toHaveBeenCalled();
  });

  it('runs the writer unlogged in shadow mode when no record log is bound', async () => {
    const fake = new Fake();
    await expect(
      recorder(fake, { shadow: true }, { log: null }).write(
        spec(),
        async () => 1
      )
    ).resolves.toBe(1);
    expect(fake.queue).toEqual([]);
  });

  it('logs each write with its row changes and a hash chain', async () => {
    const fake = new Fake();
    const log = recorder(fake, { shadow: true });
    await log.write(spec(), async () => fake.addRow(1));
    await log.write(spec(), async () => fake.addRow(1, 5));
    const [first, second] = fake.entries();
    expect(first).toMatchObject({
      kind: 'dist.airdrops',
      seq: 0,
      prev: null,
      card: CARD,
      record_id: null,
      intent,
      effects: {
        distribution: {
          upsert: [{ id: 1, wallet: '0x1', count: 1 }],
          delete: []
        }
      },
      checks: { undeclared: [], replay: 'skipped' },
      writer_error: null
    });
    expect(second.seq).toBe(1);
    expect(second.prev).toBe(entrySha256(first));
    expect(second.effects).toEqual({
      distribution: { upsert: [{ id: 1, wallet: '0x1', count: 5 }], delete: [] }
    });
    expect(fake.head).toEqual({ seq: 1, hash: entrySha256(second) });
  });

  it('replays each entry in a rolled-back savepoint and finds a match', async () => {
    const fake = new Fake();
    fake.addRow(1);
    await recorder(fake, { shadow: true, replay: true }).write(
      spec(),
      async () => fake.addRow(2)
    );
    expect(fake.entries()[0].checks.replay).toBe('match');
    expect(fake.state.distribution.map((row) => row.id)).toEqual([1, 2]);
  });

  it('reports a reducer that does not reproduce the write', async () => {
    const fake = new Fake();
    fake.applyBug = true;
    await recorder(fake, { shadow: true, replay: true }).write(
      spec(),
      async () => fake.addRow(2)
    );
    const entry = fake.entries()[0];
    expect(entry.checks.replay).toBe('mismatch');
    expect(entry.checks.replay_mismatches).toEqual(['redo:distribution']);
    // The rollback restored the writer's rows.
    expect(fake.state.distribution.map((row) => row.id)).toEqual([2]);
    expect(sendPriorityAlertIfConfigured).toHaveBeenCalled();
  });

  it('flags a part the kind does not declare', async () => {
    const fake = new Fake();
    await recorder(fake, { shadow: true }).write(spec(), async () => {
      fake.state = applyEffectsToState(fake.state, {
        claim_actions: { upsert: [{ id: 'a1', completed: 1 }], delete: [] }
      });
    });
    expect(fake.entries()[0].checks.undeclared).toEqual(['claim_actions']);
    expect(sendPriorityAlertIfConfigured).toHaveBeenCalled();
  });

  it('logs the changes of a writer that failed half way, then rethrows', async () => {
    const fake = new Fake();
    await expect(
      recorder(fake, { shadow: true }).write(spec(), async () => {
        fake.addRow(3);
        throw new Error('merkle insert failed');
      })
    ).rejects.toThrow('merkle insert failed');
    expect(fake.entries()[0]).toMatchObject({
      writer_error: 'Error: merkle insert failed',
      effects: { distribution: { upsert: [{ id: 3 }] } }
    });
  });

  it('logs nothing for a failed write that changed nothing', async () => {
    const fake = new Fake();
    await expect(
      recorder(fake, { shadow: true }).write(spec(), async () => {
        throw new Error('EMMA down');
      })
    ).rejects.toThrow('EMMA down');
    expect(fake.queue).toEqual([]);
  });

  it('logs nothing for a service write that found nothing to do', async () => {
    const fake = new Fake();
    await recorder(fake, { shadow: true }).write(
      spec({
        kind: 'claim.built',
        actor: { type: 'service', wallet: null, authority: null }
      }),
      async () => undefined
    );
    expect(fake.queue).toEqual([]);
  });

  it('keeps an admin write that changed nothing, such as a GitHub upload', async () => {
    const fake = new Fake();
    await recorder(fake, { shadow: true }).write(
      spec({
        kind: 'card.published',
        outputs: () => ({ github_folder: 'card100' })
      }),
      async () => ({})
    );
    expect(fake.entries()[0]).toMatchObject({
      kind: 'card.published',
      outputs: { github_folder: 'card100' },
      effects: {}
    });
  });

  describe('primary mode', () => {
    it('refuses an unsigned admin write before running it', async () => {
      const fake = new Fake();
      const run = jest.fn();
      await expect(
        recorder(fake, { primary: true }).write(spec(), run)
      ).rejects.toBeInstanceOf(InvalidSignedRecordException);
      expect(run).not.toHaveBeenCalled();
    });

    it('refuses a record that fails verification', async () => {
      const fake = new Fake();
      await expect(
        recorder(fake, { primary: true }).write(
          spec({ signedRecords: header(false) }),
          jest.fn()
        )
      ).rejects.toMatchObject({ details: { reason: 'sig' } });
    });

    it('refuses a record for another request', async () => {
      const fake = new Fake();
      await expect(
        recorder(fake, { primary: true }).write(
          spec({
            signedRecords: header(
              true,
              adminRecordBody('dist.airdrops', {
                ...intent,
                body: { csv: 'y' }
              })
            )
          }),
          jest.fn()
        )
      ).rejects.toMatchObject({ details: { reason: 'intent' } });
    });

    it('logs the signed record beside the entry', async () => {
      const fake = new Fake();
      await recorder(fake, { primary: true }).write(
        spec({ signedRecords: header() }),
        async () => fake.addRow(1)
      );
      expect(fake.queue.map((entry) => entry.t)).toEqual(['event', 'entry']);
      expect(fake.queue[0]).toMatchObject({
        lane: 'mint',
        grant: { grant: 'proof' }
      });
      expect(fake.entries()[0].record_id).toBe('0x' + 'e'.repeat(64));
    });

    it('refuses writes while no record log or verifier is bound', async () => {
      const fake = new Fake();
      const run = jest.fn();
      await expect(
        recorder(fake, { primary: true }, { log: null }).write(spec(), run)
      ).rejects.toBeInstanceOf(MintLogUnavailableException);
      await expect(
        recorder(fake, { primary: true }, { records: null }).write(
          spec({ signedRecords: header() }),
          run
        )
      ).rejects.toBeInstanceOf(MintLogUnavailableException);
      expect(run).not.toHaveBeenCalled();
    });

    it('undoes a change whose entry cannot be written, and answers 503', async () => {
      const fake = new Fake();
      fake.addRow(1);
      fake.failAppends = 2;
      await expect(
        recorder(fake, { primary: true }).write(
          spec({ signedRecords: header() }),
          async () => fake.addRow(2)
        )
      ).rejects.toBeInstanceOf(MintLogUnavailableException);
      expect(fake.state.distribution.map((row) => row.id)).toEqual([1]);
      expect(fake.queue).toEqual([]);
    });

    it('undoes a change whose entry cannot be written, but keeps the identity final rows the subscriptions journal owns', async () => {
      const fake = new Fake();
      const row = (phase: string | null) => ({
        id: 7,
        phase,
        phase_subscriptions: phase ? 1 : -1,
        phase_position: phase ? 1 : -1
      });
      fake.addRow(1);
      fake.state = applyEffectsToState(fake.state, {
        subscription_phases_identity: { upsert: [row(null)], delete: [] }
      });
      fake.failAppends = 2;
      const errors = jest.spyOn(Logger.prototype, 'error');
      try {
        await expect(
          recorder(fake, { primary: true }).write(
            spec({ signedRecords: header() }),
            async () => {
              fake.addRow(2);
              fake.state = applyEffectsToState(fake.state, {
                subscription_phases_identity: {
                  upsert: [row('Public')],
                  delete: []
                }
              });
            }
          )
        ).rejects.toBeInstanceOf(MintLogUnavailableException);
        expect(fake.state.distribution.map((r) => r.id)).toEqual([1]);
        expect(fake.state.subscription_phases_identity).toEqual([
          row('Public')
        ]);
        expect(errors).toHaveBeenCalledWith(
          expect.stringContaining('[MINT_LOG_REVERT_KEPT_IDENTITY_ROWS]')
        );
      } finally {
        errors.mockRestore();
      }
    });
  });

  it('keeps a shadow write that has a bad record, logged without it', async () => {
    const fake = new Fake();
    await recorder(fake, { shadow: true }).write(
      spec({ signedRecords: header(false) }),
      async () => fake.addRow(1)
    );
    expect(fake.queue.map((entry) => entry.t)).toEqual(['entry']);
    expect(fake.entries()[0].record_id).toBeNull();
  });

  it('logs in a fresh transaction when the first one is lost', async () => {
    const fake = new Fake();
    fake.failAppends = 1;
    await expect(
      recorder(fake, { shadow: true }).write(spec(), async () => {
        fake.addRow(4);
        return 'ok';
      })
    ).resolves.toBe('ok');
    expect(fake.entries()[0]).toMatchObject({
      seq: 0,
      checks: { replay: 'aborted' },
      effects: { distribution: { upsert: [{ id: 4 }] } }
    });
  });

  it('logs only declared parts when the lock is held around capture only', async () => {
    const fake = new Fake();
    await recorder(fake, { shadow: true }).write(
      spec({
        kind: 'claim.media',
        actor: { type: 'service', wallet: null, authority: null },
        lockScope: 'capture'
      }),
      async () => {
        fake.state = applyEffectsToState(fake.state, {
          claim: {
            upsert: [{ drop_id: 'd1', metadata_location: 'ar1' }],
            delete: []
          },
          // Logged by its own entry while the upload ran.
          claim_actions: { upsert: [{ id: 'a1', completed: 1 }], delete: [] }
        });
      }
    );
    expect(fake.entries()[0].effects).toEqual({
      claim: {
        upsert: [{ drop_id: 'd1', metadata_location: 'ar1' }],
        delete: []
      }
    });
  });
});

describe('MintLogRecorder.writeWithin', () => {
  beforeEach(() => jest.clearAllMocks());

  const DROP = 'drop-1';
  const COLLAB = { contract: 'collab', card_id: 0, key: DROP };
  const USER = '0x0000000000000000000000000000000000000002';
  const respondIntent = {
    route: 'POST /drops/:drop_id/collaborations/:invitation_id/response',
    params: { drop_id: DROP, invitation_id: 'inv-1' },
    body: { action: 'DECLINE', artwork_hash: 'a', terms_version: 't' }
  };

  /** The caller's connection: statements and head keys, in order. */
  function within(
    fake: Fake,
    flags: {
      shadow?: boolean;
      primary?: boolean;
      collabRecords?: boolean;
      replay?: boolean;
    }
  ): { log: MintLogRecorder; calls: string[]; transactions: () => number } {
    const calls: string[] = [];
    let transactions = 0;
    const db = () => {
      const inner = fake.db();
      return {
        executeNativeQueriesInTransaction: (fn: any) => {
          transactions++;
          return inner.executeNativeQueriesInTransaction(fn);
        },
        execute: (sql: string) => {
          calls.push(sql);
          return inner.execute(sql);
        }
      } as any;
    };
    const head = {
      lock: async (_connection: unknown, key = 'mint') => {
        calls.push(`lock ${key}`);
        return { ...fake.head };
      },
      advance: async (
        next: MintLogHead,
        _connection: unknown,
        key = 'mint'
      ) => {
        calls.push(`advance ${key}`);
        fake.head = next;
      }
    } as unknown as MintLogHeadDb;
    const log = new MintLogRecorder(
      {
        isMintLogShadowEnabled: () => !!flags.shadow,
        isMintLogPrimaryEnabled: () => !!flags.primary,
        isMintLogReplayCheckEnabled: () => !!flags.replay,
        isMintLogCollabRecordsRequired: () => !!flags.collabRecords
      },
      () => ({ records, log: fake.log }),
      db,
      fake.reader,
      fake.writer,
      head
    );
    return { log, calls, transactions: () => transactions };
  }

  function respondSpec(overrides: Partial<MintWriteSpec> = {}): MintWriteSpec {
    return {
      kind: 'collab.respond',
      card: COLLAB,
      actor: { type: 'user', wallet: USER, authority: 'invitee' },
      intent: respondIntent,
      signedRecords: null,
      ...overrides
    };
  }

  function userHeader(type = MINT_USER_RECORD_TYPE) {
    return JSON.stringify([
      {
        id: '0x' + 'f'.repeat(64),
        author: USER,
        refs: [type, 'request-2'],
        body: adminRecordBody('collab.respond', respondIntent),
        valid: true
      }
    ]);
  }

  const connection = { connection: 'caller' } as any;

  it('logs on the artwork head in the caller transaction', async () => {
    const fake = new Fake();
    const { log, calls, transactions } = within(fake, { shadow: true });
    await expect(
      log.writeWithin(respondSpec(), connection, async () => {
        fake.addRow(1);
        return 'ok';
      })
    ).resolves.toBe('ok');
    expect(transactions()).toBe(0);
    expect(calls).toEqual([
      'SAVEPOINT mint_log_within',
      `lock collab:${DROP}`,
      'RELEASE SAVEPOINT mint_log_within',
      'SAVEPOINT mint_log_within',
      `advance collab:${DROP}`,
      'RELEASE SAVEPOINT mint_log_within'
    ]);
    expect(fake.entries()[0]).toMatchObject({
      kind: 'collab.respond',
      chain: 'collab',
      seq: 0,
      prev: null,
      card: COLLAB,
      record_id: null
    });
    expect(fake.log.append).toHaveBeenCalledWith(expect.any(Array), {
      connection
    });
  });

  it("reads its kind's parts with a locking read only when its spec asks for current rows", async () => {
    const parts = async (spec: MintWriteSpec) => {
      const fake = new Fake();
      const { log } = within(fake, { shadow: true });
      const capture = jest.spyOn(fake.reader, 'capture');
      await log.writeWithin(spec, connection, async () => {
        fake.addRow(1);
      });
      return capture.mock.calls.map(([, , options]) =>
        options?.current ? Array.from(options.current) : null
      );
    };

    // Before and after the write.
    expect(await parts(respondSpec())).toEqual([null, null]);
    const own = [...MINT_KIND_PARTS['collab.respond']];
    expect(await parts(respondSpec({ readCurrent: true }))).toEqual([own, own]);
  });

  it.each([true, false])(
    "gives each capture of a memes phase write the switch's answer (%s) and its kind's parts",
    async (truth) => {
      const fake = new Fake();
      const { log } = within(fake, { shadow: true, replay: true });
      const identityTruthFor = jest.fn(async () => truth);
      Object.assign(fake.reader, { identityTruthFor });
      const capture = jest.spyOn(fake.reader, 'capture');
      await log.writeWithin(
        spec({
          kind: 'dist.phase',
          card: { contract: MEMES_CONTRACT.toLowerCase(), card_id: 1 },
          actor: { type: 'service', wallet: null, authority: 'drop-forge' },
          readCurrent: true
        }),
        connection,
        async () => {
          fake.addRow(1);
        }
      );

      const parts = [...MINT_KIND_PARTS['dist.phase']];
      expect(parts).toContain('subscription_phases_identity');
      // Before and after the write, then the replay check's undo and redo:
      // one answer, read once, and the same parts.
      expect(identityTruthFor).toHaveBeenCalledTimes(1);
      expect(
        capture.mock.calls.map(([, , options]) => ({
          identityTruth: options?.identityTruth,
          current: options?.current ? Array.from(options.current) : null
        }))
      ).toEqual(
        Array.from({ length: 4 }, () => ({
          identityTruth: truth,
          current: parts
        }))
      );
    }
  );

  it('keeps the caller write when the log fails in shadow mode', async () => {
    const fake = new Fake();
    fake.failAppends = 1;
    const { log, calls } = within(fake, { shadow: true });
    await expect(
      log.writeWithin(respondSpec(), connection, async () => {
        fake.addRow(1);
        return 'ok';
      })
    ).resolves.toBe('ok');
    expect(calls).toContain('ROLLBACK TO SAVEPOINT mint_log_within');
    expect(fake.state.distribution.map((row) => row.id)).toEqual([1]);
    expect(fake.queue).toEqual([]);
    expect(sendPriorityAlertIfConfigured).toHaveBeenCalledTimes(1);
  });

  it('fails the caller transaction when the log fails in primary mode', async () => {
    const fake = new Fake();
    fake.failAppends = 1;
    const { log, calls } = within(fake, { primary: true, collabRecords: true });
    await expect(
      log.writeWithin(
        respondSpec({ signedRecords: userHeader() }),
        connection,
        async () => fake.addRow(1)
      )
    ).rejects.toThrow('append failed');
    expect(calls.some((sql) => sql.includes('SAVEPOINT'))).toBe(false);
  });

  it('keeps shadow rules for collaboration records in primary mode by default', async () => {
    const fake = new Fake();
    const { log } = within(fake, { primary: true });
    await log.writeWithin(respondSpec(), connection, async () =>
      fake.addRow(1)
    );
    await log.writeWithin(
      respondSpec({ signedRecords: userHeader(MINT_ADMIN_RECORD_TYPE) }),
      connection,
      async () => fake.addRow(2)
    );
    expect(fake.entries().map((entry) => entry.record_id)).toEqual([
      null,
      null
    ]);
    expect(fake.state.distribution.map((row) => row.id)).toEqual([1, 2]);
    // Still primary: the entry itself must be written.
    fake.failAppends = 1;
    await expect(
      log.writeWithin(respondSpec(), connection, async () => fake.addRow(3))
    ).rejects.toThrow('append failed');
  });

  it('needs a mint.user record from a user in primary mode once required', async () => {
    const fake = new Fake();
    const { log } = within(fake, { primary: true, collabRecords: true });
    await expect(
      log.writeWithin(respondSpec(), connection, async () => fake.addRow(1))
    ).rejects.toBeInstanceOf(InvalidSignedRecordException);
    await expect(
      log.writeWithin(
        respondSpec({ signedRecords: userHeader(MINT_ADMIN_RECORD_TYPE) }),
        connection,
        async () => fake.addRow(1)
      )
    ).rejects.toThrow('refs must be ["mint.user", key]');
    expect(fake.state.distribution).toEqual([]);
    await log.writeWithin(
      respondSpec({ signedRecords: userHeader() }),
      connection,
      async () => fake.addRow(1)
    );
    expect(fake.entries()[0].record_id).toBe('0x' + 'f'.repeat(64));
    expect(fake.state.distribution.map((row) => row.id)).toEqual([1]);
  });

  it('takes the authority of the enclosing write, and skips a no-op', async () => {
    const fake = new Fake();
    const { log } = within(fake, { primary: true });
    const enclosed = respondSpec({
      kind: 'collab.artwork',
      intent: { route: 'drop.write', params: { drop_id: DROP }, body: null },
      enclosing: 'drop.write'
    });
    await log.writeWithin(enclosed, connection, async () => undefined);
    expect(fake.entries()).toEqual([]);
    await log.writeWithin(enclosed, connection, async () => fake.addRow(1));
    expect(fake.entries()).toHaveLength(1);
    expect(fake.entries()[0].record_id).toBeNull();
  });

  it('logs nothing when the writer throws', async () => {
    const fake = new Fake();
    const { log } = within(fake, { shadow: true });
    await expect(
      log.writeWithin(respondSpec(), connection, async () => {
        throw new Error('invitation closed');
      })
    ).rejects.toThrow('invitation closed');
    expect(fake.queue).toEqual([]);
  });

  it('needs the drop id before it can lock a collaboration', async () => {
    const fake = new Fake();
    const { log } = within(fake, { primary: true });
    const writer = jest.fn(async () => undefined);
    await expect(
      log.write(
        respondSpec({
          kind: 'collab.freeze',
          actor: { type: 'service', wallet: null, authority: null },
          card: async () => COLLAB
        }),
        writer
      )
    ).rejects.toThrow('needs its drop id');
    expect(writer).not.toHaveBeenCalled();
  });
});

describe('MintLogRecorder record checks', () => {
  beforeEach(() => jest.clearAllMocks());

  const failing: MintSignedRecordsPort = {
    ...records,
    verify: async () => {
      throw new Error('grant lookup timed out');
    }
  };

  it('keeps a shadow write going when the verifier itself fails', async () => {
    const fake = new Fake();
    await recorder(fake, { shadow: true }, { records: failing }).write(
      spec({ signedRecords: header() }),
      async () => fake.addRow(1)
    );
    expect(fake.entries()[0].record_id).toBeNull();
  });

  it('answers unavailable in primary mode when the verifier fails', async () => {
    const fake = new Fake();
    await expect(
      recorder(fake, { primary: true }, { records: failing }).write(
        spec({ signedRecords: header() }),
        async () => fake.addRow(1)
      )
    ).rejects.toBeInstanceOf(MintLogUnavailableException);
    expect(fake.state.distribution).toEqual([]);
  });
});

describe('MintLogRecorder when the log itself fails', () => {
  beforeEach(() => jest.clearAllMocks());

  const media = (overrides: Partial<MintWriteSpec> = {}) =>
    spec({
      kind: 'claim.media',
      actor: { type: 'service', wallet: null, authority: null },
      lockScope: 'capture',
      ...overrides
    });
  const upload = (fake: Fake) => async () => {
    fake.state = applyEffectsToState(fake.state, {
      claim: {
        upsert: [{ drop_id: 'd1', metadata_location: 'ar1' }],
        delete: []
      }
    });
    return 'uploaded';
  };

  it('runs the writer unlogged in shadow mode when the head cannot be locked', async () => {
    const fake = new Fake();
    fake.failLocks = 1;
    await expect(
      recorder(fake, { shadow: true }).write(spec(), async () => {
        fake.addRow(1);
        return 'written';
      })
    ).resolves.toBe('written');
    expect(fake.state.distribution.map((row) => row.id)).toEqual([1]);
    expect(fake.queue).toEqual([]);
    expect(sendPriorityAlertIfConfigured).toHaveBeenCalledWith(
      'Mint log',
      expect.objectContaining({
        message: expect.stringContaining('[MINT_LOG_SHADOW_SKIPPED]')
      })
    );
  });

  it('runs the writer unlogged in shadow mode when the ports cannot be built', async () => {
    const fake = new Fake();
    const log = new MintLogRecorder(
      {
        isMintLogShadowEnabled: () => true,
        isMintLogPrimaryEnabled: () => false,
        isMintLogReplayCheckEnabled: () => false
      },
      () => {
        throw new Error('no table');
      },
      fake.db,
      fake.reader,
      fake.writer,
      fake.headDb
    );
    await expect(log.write(spec(), async () => 'written')).resolves.toBe(
      'written'
    );
  });

  it('fails the write before the writer in primary mode when the head cannot be locked', async () => {
    const fake = new Fake();
    fake.failLocks = 1;
    const writer = jest.fn(async () => fake.addRow(1));
    await expect(
      recorder(fake, { primary: true }).write(
        spec({ signedRecords: header() }),
        writer
      )
    ).rejects.toThrow('Lock wait timeout');
    expect(writer).not.toHaveBeenCalled();
  });

  it('logs a long write after its upload even when the first log attempt fails', async () => {
    const fake = new Fake();
    fake.failAppends = 1;
    await expect(
      recorder(fake, { shadow: true }).write(media(), upload(fake))
    ).resolves.toBe('uploaded');
    expect(fake.entries()).toHaveLength(1);
    expect(fake.entries()[0].effects.claim?.upsert).toHaveLength(1);
  });

  it('keeps a long write in shadow mode when its entry cannot be written, and alerts', async () => {
    const fake = new Fake();
    fake.failAppends = 2;
    await expect(
      recorder(fake, { shadow: true }).write(media(), upload(fake))
    ).resolves.toBe('uploaded');
    expect(fake.entries()).toEqual([]);
    expect(fake.state.claim).toHaveLength(1);
    expect(sendPriorityAlertIfConfigured).toHaveBeenCalledWith(
      'Mint log',
      expect.objectContaining({
        message: expect.stringContaining('[MINT_LOG_ENTRY_LOST]')
      })
    );
  });

  it('undoes a long write in primary mode when its entry cannot be written', async () => {
    const fake = new Fake();
    fake.failAppends = 2;
    await expect(
      recorder(fake, { primary: true }).write(media(), upload(fake))
    ).rejects.toBeInstanceOf(MintLogUnavailableException);
    expect(fake.state.claim).toEqual([]);
  });

  it('runs a long write unlogged in shadow mode when its capture fails', async () => {
    const fake = new Fake();
    const log = new MintLogRecorder(
      {
        isMintLogShadowEnabled: () => true,
        isMintLogPrimaryEnabled: () => false,
        isMintLogReplayCheckEnabled: () => false
      },
      () => ({ records, log: fake.log }),
      fake.db,
      {
        capture: async () => {
          throw new Error('capture failed');
        }
      } as unknown as MintStateReader,
      fake.writer,
      fake.headDb
    );
    await expect(log.write(media(), upload(fake))).resolves.toBe('uploaded');
    expect(fake.state.claim).toHaveLength(1);
  });
});

describe('MintLogRecorder shadow record warnings', () => {
  it('name the wallet, so an admin without a record can be found', async () => {
    const warn = jest.spyOn(Logger.get('MINT_LOG'), 'warn');
    const fake = new Fake();
    await recorder(fake, { shadow: true }).write(spec(), async () =>
      fake.addRow(1)
    );
    expect(warn).toHaveBeenCalledWith(
      `[MINT_LOG_SHADOW_RECORD] [dist.airdrops] [missing] [wallet ${ADMIN}] this write needs a signed mint.admin record`
    );
    warn.mockRestore();
  });
});
