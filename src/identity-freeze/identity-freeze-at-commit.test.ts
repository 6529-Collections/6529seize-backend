import type { PoolConnection } from 'mysql';
import { execNativeTransactionally } from '@/db/my-sql.helpers';
import {
  closeAfterCommitScope,
  openAfterCommitScope,
  runBeforeCommitChecks
} from '@/db/after-commit';
import {
  assertIdentityNotFrozen,
  assertIdentityNotFrozenAtCommit,
  IDENTITY_FREEZE_AT_ENV,
  IDENTITY_FROZEN_MESSAGE,
  IDENTITY_FROZEN_NOMINATION_MESSAGE,
  IDENTITY_ON_CHAIN_MESSAGE,
  IDENTITY_SWITCH_ON_AT_ENV,
  IdentityFrozenException,
  isIdentityFreezeConfigured
} from '@/identity-freeze/identity-freeze';
import { Time } from '@/time';
import {
  clearFreezeSettings,
  expectCommitted,
  expectRefusedAtCommit,
  fakePoolConnection,
  freezeClock,
  settle
} from '@/tests/fixtures/freeze-at-commit.fixture';

/** How many checks ran at COMMIT: clock reads between the work and COMMIT. */
function countClockReadsAtCommit(connection: PoolConnection) {
  const counted = { atCommit: -1, afterWork: 0 };
  const commit = connection.commit.bind(connection);
  jest.spyOn(connection, 'commit').mockImplementation(((callback: any) => {
    counted.atCommit = (Time.currentMillis as jest.Mock).mock.calls.length;
    return commit(callback);
  }) as any);
  return {
    markWorkDone() {
      counted.afterWork = (Time.currentMillis as jest.Mock).mock.calls.length;
    },
    checksRun() {
      return counted.atCommit - counted.afterWork;
    }
  };
}

describe('isIdentityFreezeConfigured', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = clearFreezeSettings();
  });
  afterEach(() => {
    restore();
  });

  it('is false with every freeze and switch-on setting unset', () => {
    expect(isIdentityFreezeConfigured()).toBe(false);
  });

  it.each([
    ['FEATURE_IDENTITY_FROZEN', 'false'],
    ['FEATURE_IDENTITY_ON_CHAIN', 'false'],
    [IDENTITY_FREEZE_AT_ENV, ''],
    [IDENTITY_SWITCH_ON_AT_ENV, '   ']
  ])('is false with %s=%p, which freezes nothing', (name, value) => {
    process.env[name] = value;
    expect(isIdentityFreezeConfigured()).toBe(false);
  });

  it.each([
    ['FEATURE_IDENTITY_FROZEN', 'true'],
    ['FEATURE_IDENTITY_ON_CHAIN', 'true'],
    [IDENTITY_FREEZE_AT_ENV, '2030-01-01T00:00:00Z'],
    [IDENTITY_FREEZE_AT_ENV, 'not a time'],
    [IDENTITY_SWITCH_ON_AT_ENV, '2030-01-01T00:00:00Z'],
    [IDENTITY_SWITCH_ON_AT_ENV, 'not a time']
  ])('is true with %s=%p', (name, value) => {
    process.env[name] = value;
    expect(isIdentityFreezeConfigured()).toBe(true);
  });
});

describe('assertIdentityNotFrozenAtCommit with no freeze setting at all', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = clearFreezeSettings();
  });
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  it('registers nothing inside a transaction: the commit runs no check and sends what it sent before', async () => {
    const { connection, statements } = fakePoolConnection();
    const clock = jest.spyOn(Time, 'currentMillis');

    await execNativeTransactionally(async (bound) => {
      assertIdentityNotFrozenAtCommit(bound);
      assertIdentityNotFrozenAtCommit(bound, 'nomination');
      statements.push('WORK');
      // Had anything been registered, it would refuse at COMMIT now.
      process.env.FEATURE_IDENTITY_FROZEN = 'true';
    }, connection);

    expect(statements).toEqual(['BEGIN', 'WORK', 'COMMIT', 'RELEASE']);
    expect(clock).not.toHaveBeenCalled();
  });

  it('leaves runBeforeCommitChecks nothing to run', () => {
    const handle = {};
    openAfterCommitScope(handle);
    assertIdentityNotFrozenAtCommit({ connection: handle });
    process.env.FEATURE_IDENTITY_FROZEN = 'true';
    expect(() => runBeforeCommitChecks(handle)).not.toThrow();
    closeAfterCommitScope(handle);
  });

  it('checks nothing outside a transaction either', () => {
    const clock = jest.spyOn(Time, 'currentMillis');
    expect(() => assertIdentityNotFrozenAtCommit(undefined)).not.toThrow();
    expect(() =>
      assertIdentityNotFrozenAtCommit({ connection: {} }, 'nomination')
    ).not.toThrow();
    expect(clock).not.toHaveBeenCalled();
  });
});

describe('assertIdentityNotFrozenAtCommit with a freeze time', () => {
  let clock: ReturnType<typeof freezeClock>;
  beforeEach(() => {
    clock = freezeClock();
  });
  afterEach(() => {
    clock.restore();
    jest.restoreAllMocks();
  });

  it.each([
    ['a write', 'write', IDENTITY_FROZEN_MESSAGE],
    ['a nomination', 'nomination', IDENTITY_FROZEN_NOMINATION_MESSAGE]
  ] as const)(
    'refuses %s admitted before T whose transaction commits after T, with the same 423 as the first check',
    async (_, kind, message) => {
      const { connection, statements } = fakePoolConnection();

      const run = execNativeTransactionally(async (bound) => {
        assertIdentityNotFrozen(kind);
        assertIdentityNotFrozenAtCommit(bound, kind);
        statements.push('WRITE');
        // A row lock held past T.
        clock.pass();
      }, connection);

      await expectRefusedAtCommit(run, statements, message);
      expect(statements).toEqual(['BEGIN', 'WRITE', 'ROLLBACK', 'RELEASE']);

      // The same refusal the first check gives a write that arrives after T.
      expect(() => assertIdentityNotFrozen(kind)).toThrow(
        new IdentityFrozenException(message)
      );
    }
  );

  it('commits a write whose transaction ends before T, running the check once', async () => {
    const { connection, statements } = fakePoolConnection();
    const counter = countClockReadsAtCommit(connection);

    await execNativeTransactionally(async (bound) => {
      assertIdentityNotFrozenAtCommit(bound);
      assertIdentityNotFrozenAtCommit(bound);
      statements.push('WRITE');
      counter.markWorkDone();
    }, connection);

    expectCommitted(statements);
    expect(counter.checksRun()).toBe(1);
  });

  it('refuses at commit with the switch-on message once switch-on passes', async () => {
    delete process.env[IDENTITY_FREEZE_AT_ENV];
    process.env[IDENTITY_SWITCH_ON_AT_ENV] = String(clock.T);
    const { connection, statements } = fakePoolConnection();

    const run = execNativeTransactionally(async (bound) => {
      assertIdentityNotFrozen();
      assertIdentityNotFrozenAtCommit(bound);
      clock.pass();
    }, connection);

    await expectRefusedAtCommit(run, statements, IDENTITY_ON_CHAIN_MESSAGE);
  });

  it('answers with the first registered refusal when a write and a nomination share a transaction', async () => {
    const { connection, statements } = fakePoolConnection();

    const run = execNativeTransactionally(async (bound) => {
      assertIdentityNotFrozenAtCommit(bound);
      assertIdentityNotFrozenAtCommit(bound, 'nomination');
      clock.pass();
    }, connection);

    await expectRefusedAtCommit(run, statements, IDENTITY_FROZEN_MESSAGE);
  });

  it('checks at once outside a transaction', () => {
    expect(() => assertIdentityNotFrozenAtCommit(undefined)).not.toThrow();
    clock.pass();
    expect(() => assertIdentityNotFrozenAtCommit(undefined)).toThrow(
      IdentityFrozenException
    );
    expect(() =>
      assertIdentityNotFrozenAtCommit({ connection: {} }, 'nomination')
    ).toThrow(IDENTITY_FROZEN_NOMINATION_MESSAGE);
  });

  it('leaves the next transaction on the same pooled connection unchecked', async () => {
    const { connection, statements } = fakePoolConnection();

    const first = await settle(
      execNativeTransactionally(async (bound) => {
        assertIdentityNotFrozenAtCommit(bound);
        clock.pass();
      }, connection)
    );
    expect(first.error).toBeInstanceOf(IdentityFrozenException);

    // A write that is not an identity write, after T, on the same connection.
    statements.length = 0;
    await expect(
      execNativeTransactionally(async () => {
        statements.push('WAVE WRITE');
        return 'ok';
      }, connection)
    ).resolves.toBe('ok');
    expect(statements).toEqual(['BEGIN', 'WAVE WRITE', 'COMMIT', 'RELEASE']);
  });
});
