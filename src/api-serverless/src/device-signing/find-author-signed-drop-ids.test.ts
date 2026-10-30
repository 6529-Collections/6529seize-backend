import { mock } from 'ts-jest-mocker';
import { AuthenticationContext } from '@/auth-context';
import { DbPoolName } from '@/db-query.options';
import { DropsDb } from '@/drops/drops.db';
import { IdentitiesDb } from '@/identities/identities.db';
import { SqlExecutor } from '@/sql-executor';
import { DeviceEventKind } from './device-event';
import { DeviceSigningDb } from './device-signing.db';
import {
  DeviceSignedWritesService,
  SignedWriteContext
} from './device-signed-writes.service';

interface ExecutedQuery {
  readonly sql: string;
  readonly params: Record<string, any> | undefined;
  readonly options: Record<string, unknown> | undefined;
}

/**
 * Emulates the drop_author_signatures statements DeviceSigningDb issues, so
 * the real writes service and the real lookup share one in-memory table.
 */
function inMemoryAuthorSignatures() {
  const rows = new Map<string, { eventId: string; signedAt: number }>();
  const queries: ExecutedQuery[] = [];
  const execute = jest.fn(
    async (
      sql: string,
      params?: Record<string, any>,
      options?: Record<string, unknown>
    ): Promise<any[]> => {
      queries.push({ sql, params, options });
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (statement.startsWith('insert into drop_author_signatures')) {
        const current = rows.get(params!.dropId);
        if (!current || params!.signedAt >= current.signedAt) {
          rows.set(params!.dropId, {
            eventId: params!.eventId,
            signedAt: params!.signedAt
          });
        }
      } else if (statement.startsWith('delete from drop_author_signatures')) {
        rows.delete(params!.dropId);
      } else if (
        statement.startsWith(
          'select drop_id from drop_author_signatures where drop_id in'
        )
      ) {
        return (params!.dropIds as string[])
          .filter((dropId) => rows.has(dropId))
          .map((dropId) => ({ drop_id: dropId }));
      } else if (
        statement.startsWith('select event_id from drop_author_signatures')
      ) {
        const row = rows.get(params!.dropId);
        return row ? [{ event_id: row.eventId }] : [];
      }
      return [];
    }
  );
  const executor = {
    execute,
    executeNativeQueriesInTransaction: async (
      fn: (connection: { connection: unknown }) => Promise<unknown>
    ) => fn({ connection: 'tx' })
  } as unknown as SqlExecutor;
  return { db: new DeviceSigningDb(() => executor), rows, queries, execute };
}

const ctx: SignedWriteContext = {
  authenticationContext: AuthenticationContext.notAuthenticated()
};
const WAVE_ID = 'wave-1';
const DROP_ID = 'drop-1';
const ENVELOPE = { grant_id: 'grant-1' };

describe('DeviceSigningDb.findAuthorSignedDropIds', () => {
  it('looks up a page of drops by primary key in one query of distinct ids', async () => {
    const { db, rows, queries } = inMemoryAuthorSignatures();
    rows.set('signed-1', { eventId: '0x01', signedAt: 1 });
    rows.set('signed-2', { eventId: '0x02', signedAt: 1 });

    const signed = await db.findAuthorSignedDropIds(
      ['signed-1', 'unsigned', 'signed-1', 'signed-2', 'unsigned'],
      {}
    );

    expect(signed).toEqual(new Set(['signed-1', 'signed-2']));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toBe(
      'select drop_id from drop_author_signatures where drop_id in (:dropIds)'
    );
    expect(queries[0].params).toEqual({
      dropIds: ['signed-1', 'unsigned', 'signed-2']
    });
  });

  it('skips the query for an empty page', async () => {
    const { db, execute } = inMemoryAuthorSignatures();

    await expect(db.findAuthorSignedDropIds([], {})).resolves.toEqual(
      new Set()
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('reads as unsigned when the lookup fails', async () => {
    const { db, execute } = inMemoryAuthorSignatures();
    execute.mockRejectedValueOnce(new Error('ER_NO_SUCH_TABLE'));

    await expect(db.findAuthorSignedDropIds([DROP_ID], {})).resolves.toEqual(
      new Set()
    );
  });

  it('uses the caller connection or the requested pool', async () => {
    const { db, queries } = inMemoryAuthorSignatures();
    const connection = { connection: 'tx' };

    await db.findAuthorSignedDropIds([DROP_ID], { connection });
    await db.findAuthorSignedDropIds([DROP_ID], {}, DbPoolName.WRITE);

    expect(queries[0].options).toEqual({ wrappedConnection: connection });
    expect(queries[1].options).toEqual({ forcePool: DbPoolName.WRITE });
  });
});

describe('author signed status across drop writes', () => {
  let store: ReturnType<typeof inMemoryAuthorSignatures>;
  let service: DeviceSignedWritesService;
  let receivedAt: number;
  let eventCount: number;

  beforeEach(() => {
    store = inMemoryAuthorSignatures();
    receivedAt = 1_000;
    eventCount = 0;
    service = new DeviceSignedWritesService(
      store.db,
      mock(IdentitiesDb),
      mock(DropsDb),
      () => receivedAt
    );
    // Signature verification has its own suite; reserve a verified event.
    jest
      .spyOn(service, 'verifyAndReserve')
      .mockImplementation(async (_envelope, target) => {
        eventCount++;
        receivedAt++;
        return {
          eventId: `0xevent${eventCount}`,
          grantId: 'grant-1',
          kind: target.kind,
          receivedAt
        };
      });
  });

  afterEach(() => jest.restoreAllMocks());

  async function post(signed: boolean): Promise<void> {
    await service.createDrop(
      {
        envelope: signed ? ENVELOPE : undefined,
        waveId: WAVE_ID,
        replyToDropId: null,
        body: {}
      },
      async () => ({ id: DROP_ID }),
      ctx
    );
  }

  async function mutate(
    kind: DeviceEventKind.EDIT | DeviceEventKind.TOMBSTONE,
    signed: boolean
  ): Promise<void> {
    await service.mutateDrop(
      {
        envelope: signed ? ENVELOPE : undefined,
        kind,
        dropId: DROP_ID,
        waveId: WAVE_ID,
        body: kind === DeviceEventKind.EDIT ? {} : null
      },
      async () => undefined,
      ctx
    );
  }

  /** is_author_signed and current_event_id must always agree. */
  async function authorSignedState() {
    const [signedDropIds, currentEventId] = await Promise.all([
      store.db.findAuthorSignedDropIds([DROP_ID], {}),
      store.db.findDropAuthorSignatureEventId(DROP_ID, {})
    ]);
    expect(signedDropIds.has(DROP_ID)).toBe(currentEventId !== null);
    return { signed: signedDropIds.has(DROP_ID), currentEventId };
  }

  it('is signed after a device signed post', async () => {
    await post(true);

    expect(await authorSignedState()).toEqual({
      signed: true,
      currentEventId: '0xevent1'
    });
  });

  it('is not signed after an unsigned post', async () => {
    await post(false);

    expect(await authorSignedState()).toEqual({
      signed: false,
      currentEventId: null
    });
  });

  it('is not signed once a signed drop is edited without a signature', async () => {
    await post(true);
    await mutate(DeviceEventKind.EDIT, false);

    expect(await authorSignedState()).toEqual({
      signed: false,
      currentEventId: null
    });
  });

  it('follows the latest signed edit', async () => {
    await post(true);
    await mutate(DeviceEventKind.EDIT, true);

    expect(await authorSignedState()).toEqual({
      signed: true,
      currentEventId: '0xevent2'
    });
  });

  it.each([true, false])(
    'is not signed after a delete (signed delete: %s)',
    async (signedDelete) => {
      await post(true);
      await mutate(DeviceEventKind.TOMBSTONE, signedDelete);

      expect(await authorSignedState()).toEqual({
        signed: false,
        currentEventId: null
      });
    }
  );
});
