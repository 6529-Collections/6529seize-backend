import {
  ProfileCmsPrivateLog,
  readProfileCmsPrivateEntry
} from '@/profile-cms/personal-log/profile-cms-private-log';
import { profileCmsPrivateEntries } from '@/profile-cms/personal-log/profile-cms-rebuild';
import { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { SqlExecutor } from '@/sql-executor';

function setup(
  enabled: boolean,
  row: Record<string, unknown> | null,
  head: { height: number | string; doc_version: number | string } | null = null
) {
  const execute = jest
    .fn()
    .mockResolvedValueOnce(row ? [row] : [])
    .mockResolvedValueOnce(head ? [head] : []);
  const append = jest.fn().mockResolvedValue(undefined);
  const log = new ProfileCmsPrivateLog(
    () => ({ execute }) as unknown as SqlExecutor,
    { append },
    { isProfileCmsPersonalLogEnabled: () => enabled },
    () => 1234
  );
  return { log, execute, append };
}

describe('ProfileCmsPrivateLog', () => {
  it('appends the row as it stands, as a private service entry of lane publish', async () => {
    const { log, append, execute } = setup(
      true,
      {
        id: 'draft-1',
        profile_id: 'profile-1',
        cms_package: '{"a":1}',
        is_primary: 0,
        published_at: null,
        created_at: 5
      },
      { height: '120', doc_version: 3 }
    );
    await log.rowWritten('cms.package', 'draft-1', { timer: undefined });
    expect(execute.mock.calls[0][0]).toContain(
      'select * from profile_cms_packages where id = :id'
    );
    // Stamped with the change the index had last applied for that profile.
    expect(execute.mock.calls[1][0]).toContain(
      'select height, doc_version from profile_cms_chain_heads'
    );
    expect(execute.mock.calls[1][1]).toEqual({ profileId: 'profile-1' });
    expect(append).toHaveBeenCalledWith(
      [
        {
          t: 'entry',
          lane: 'publish',
          chain: 'private',
          body: {
            v: 1,
            kind: 'cms.package',
            at: 1234,
            height: 120,
            doc_version: 3,
            row: {
              id: 'draft-1',
              profile_id: 'profile-1',
              cms_package: '{"a":1}',
              is_primary: 0,
              published_at: null,
              created_at: 5
            }
          }
        }
      ],
      { timer: undefined }
    );
  });

  it('stamps no change before the index applied anything for the profile', async () => {
    const { log, append } = setup(true, { id: 'g', profile_id: 'p' }, null);
    await log.rowWritten('cms.agent-grant', 'g', { timer: undefined });
    expect(append.mock.calls[0][0][0].body).toMatchObject({
      height: null,
      doc_version: null
    });
  });

  describe('logged', () => {
    function transactional(enabled: boolean) {
      const connection = { connection: 'tx' };
      const execute = jest.fn().mockImplementation(async (sql: string) => {
        if (sql.startsWith('select *')) {
          return [{ id: 'row-1', profile_id: 'p' }];
        }
        // logExistingRows lists each table's ids.
        return sql.startsWith('select id as id') ? [{ id: 'row-1' }] : [];
      });
      const executeNativeQueriesInTransaction = jest.fn(
        async (fn: (c: unknown) => Promise<unknown>) => fn(connection)
      );
      const append = jest.fn().mockResolvedValue(undefined);
      const log = new ProfileCmsPrivateLog(
        () =>
          ({
            execute,
            executeNativeQueriesInTransaction
          }) as unknown as SqlExecutor,
        { append },
        { isProfileCmsPersonalLogEnabled: () => enabled },
        () => 1
      );
      return { log, connection, append, executeNativeQueriesInTransaction };
    }

    it('opens a transaction for a write that has none, so the append rolls it back on failure', async () => {
      const { log, connection, append, executeNativeQueriesInTransaction } =
        transactional(true);
      const write = jest.fn().mockResolvedValue(undefined);
      await log.logged(
        { timer: undefined },
        [['cms.pointer-event', 'row-1']],
        write
      );
      expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][0]).toMatchObject({ connection });
      expect(append.mock.calls[0][1]).toMatchObject({ connection });
      expect(append.mock.calls[0][0][0].body).toMatchObject({
        kind: 'cms.pointer-event'
      });
    });

    it("uses the caller's transaction when it has one", async () => {
      const { log, append, executeNativeQueriesInTransaction } =
        transactional(true);
      const ctx = { timer: undefined, connection: { connection: 'caller' } };
      const write = jest.fn().mockResolvedValue(undefined);
      await log.logged(ctx as never, [['cms.package', 'row-1']], write);
      expect(executeNativeQueriesInTransaction).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledWith(ctx);
      expect(append.mock.calls[0][1]).toBe(ctx);
    });

    it('logs the rows a write finds itself, in its transaction', async () => {
      const { log, connection, append, executeNativeQueriesInTransaction } =
        transactional(true);
      await log.loggedWrite({ timer: undefined }, async (txCtx) => {
        expect(txCtx).toMatchObject({ connection });
        return [
          ['cms.package', 'row-1'],
          ['cms.package', 'row-1']
        ];
      });
      expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
      expect(append).toHaveBeenCalledTimes(2);
      expect(append.mock.calls[1][1]).toMatchObject({ connection });
    });

    it('reads each existing row and its stamp in one transaction', async () => {
      const { log, append, executeNativeQueriesInTransaction } =
        transactional(true);
      const logged = await log.logExistingRows({ timer: undefined });
      // One row per table in this fake: one transaction per row.
      expect(logged).toBe(6);
      expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(6);
      for (const call of append.mock.calls) {
        expect(call[1]).toMatchObject({ connection: { connection: 'tx' } });
      }
    });

    it('only writes with the flag off', async () => {
      const { log, append, executeNativeQueriesInTransaction } =
        transactional(false);
      const write = jest.fn().mockResolvedValue(undefined);
      await log.logged({ timer: undefined }, [['cms.package', 'row-1']], write);
      expect(write).toHaveBeenCalledTimes(1);
      expect(executeNativeQueriesInTransaction).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    });
  });

  it('does nothing with the flag off', async () => {
    const { log, append, execute } = setup(false, { id: 'draft-1' });
    await log.rowWritten('cms.agent-grant', 'grant-1', { timer: undefined });
    expect(execute).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('skips a row that is gone', async () => {
    const { log, append } = setup(true, null);
    await log.rowWritten('cms.agent-event', 'event-1', { timer: undefined });
    expect(append).not.toHaveBeenCalled();
  });

  it('writes a logged row back over its key', async () => {
    const { log, execute } = setup(true, null);
    await log.applyEntry(
      {
        v: 1,
        kind: 'cms.agent-proposal',
        at: 1,
        height: null,
        doc_version: null,
        row: { status: 'pending', id: 'proposal-1', candidate_package: '{}' }
      },
      { timer: undefined }
    );
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain('insert into profile_cms_agent_proposals');
    expect(sql).toContain('`status` = values(`status`)');
    expect(sql).not.toContain('`id` = values(`id`)');
    expect(params).toEqual({
      candidate_package: '{}',
      id: 'proposal-1',
      status: 'pending'
    });
  });

  it.each([[{ id: 'x', 'bad column': 1 }], [{ status: 'missing key' }]])(
    'refuses a malformed row %j',
    async (row) => {
      const { log } = setup(true, null);
      await expect(
        log.applyEntry(
          { v: 1, kind: 'cms.package', at: 1, height: 3, doc_version: 1, row },
          { timer: undefined }
        )
      ).rejects.toThrow('Malformed profile site log entry');
    }
  );
});

describe('reading private entries', () => {
  it('keeps lane publish service entries and refuses malformed ones', async () => {
    const entries: RecordLogEntry[] = [
      {
        t: 'entry',
        lane: 'subs',
        chain: 'private',
        body: { anything: true }
      },
      {
        t: 'entry',
        lane: 'publish',
        chain: 'private',
        body: {
          v: 1,
          kind: 'cms.agent-grant',
          at: 7,
          height: 110,
          doc_version: 2,
          row: { id: 'g' }
        }
      }
    ];
    const walk = (async function* () {
      for (const entry of entries) yield { entry };
    })();
    const read = [];
    for await (const entry of profileCmsPrivateEntries(walk)) read.push(entry);
    expect(read).toEqual([
      {
        v: 1,
        kind: 'cms.agent-grant',
        at: 7,
        height: 110,
        doc_version: 2,
        row: { id: 'g' }
      }
    ]);
    expect(
      readProfileCmsPrivateEntry({
        v: 1,
        kind: 'cms.other',
        at: 1,
        height: null,
        doc_version: null,
        row: {}
      })
    ).toBeNull();
    // An entry without its change can't be placed against the chain.
    expect(
      readProfileCmsPrivateEntry({
        v: 1,
        kind: 'cms.package',
        at: 1,
        height: 3,
        doc_version: null,
        row: {}
      })
    ).toBeNull();
    expect(
      readProfileCmsPrivateEntry({
        v: 1,
        kind: 'cms.package',
        at: 1,
        row: {}
      })
    ).toBeNull();
    const bad = (async function* () {
      yield {
        entry: {
          t: 'entry' as const,
          lane: 'publish',
          chain: 'private' as const,
          body: { v: 2 }
        }
      };
    })();
    await expect(async () => {
      for await (const _ of profileCmsPrivateEntries(bad)) {
        // drain
      }
    }).rejects.toThrow('Malformed profile site entry');
  });
});

describe('rebuildProfileCmsFromChainAndLog', () => {
  const emptyRecordLog = {
    wave: { drops: async function* () {} },
    fetcher: {
      fetchCid: async () => Buffer.alloc(0),
      fetchArweave: async () => Buffer.alloc(0)
    },
    serviceWallets: ['0x00000000000000000000000000000000000000a1'],
    providers: []
  };

  it('reads no chain with the chain flag off, as the live index applied none', async () => {
    const { rebuildProfileCmsFromChainAndLog } =
      await import('@/profile-cms/personal-log/profile-cms-rebuild');
    const createPort = jest.fn();
    await expect(
      rebuildProfileCmsFromChainAndLog(
        { sources: { gateway: 'https://gateway.example.test', files: null } },
        {
          features: { isProfileCmsChainPointerEnabled: () => false },
          createPort,
          recordLog: emptyRecordLog
        }
      )
    ).resolves.toEqual({ changes: 0, entries: 0 });
    expect(createPort).not.toHaveBeenCalled();
  });

  it("reads the chain at the run's gateway with the chain flag on", async () => {
    const { rebuildProfileCmsFromChainAndLog } =
      await import('@/profile-cms/personal-log/profile-cms-rebuild');
    const getChanges = jest
      .fn()
      .mockResolvedValue({ changes: [], next_height: null });
    const createPort = jest.fn().mockReturnValue({ getChanges });
    await rebuildProfileCmsFromChainAndLog(
      { sources: { gateway: 'https://gateway.example.test', files: null } },
      {
        features: { isProfileCmsChainPointerEnabled: () => true },
        createPort,
        recordLog: emptyRecordLog,
        env: { PROFILE_CMS_CHAIN_FROM_HEIGHT: '7' }
      }
    );
    expect(createPort).toHaveBeenCalledWith('https://gateway.example.test');
    expect(getChanges).toHaveBeenCalledWith(7);
  });

  it('refuses without a files source or the records settings', async () => {
    const { profileCmsRecordLogSources } =
      await import('@/profile-cms/personal-log/profile-cms-rebuild');
    expect(() => profileCmsRecordLogSources(null, {})).toThrow(
      'no files source'
    );
    expect(() =>
      profileCmsRecordLogSources('http://127.0.0.1:1', {
        SIGNED_RECORDS_WAVE_ID: 'wave'
      })
    ).toThrow('SIGNED_RECORDS_WAVE_ID');
  });
});
