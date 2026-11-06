import {
  DROP_VOTER_STATE_TABLE,
  IDENTITIES_TABLE,
  TDH_NFT_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  WAVES_TABLE,
  WS_CONNECTIONS_TABLE,
  WS_NOTIFICATION_SUBSCRIPTIONS_TABLE
} from '@/constants';
import { WaveCreditScope, WaveCreditType } from '@/entities/IWave';
import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import { WsConnectionRepository } from './ws-connection.repository';
import { WsConnectionPurpose } from '@/entities/IWSConnection';
import { legacyGetView } from '@/competitions/legacy-competition-get-facade';

describe('WsConnectionRepository', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([false, true])(
    'intersects live parent and child websocket recipients (system=%s)',
    async (system) => {
      const oneOrNull = jest.fn().mockResolvedValue({
        visibility_group_id: 'child',
        parent_wave_id: 'parent',
        parent_id: 'parent',
        parent_parent_id: null,
        parent_group_id: 'parent-group'
      });
      const execute = jest
        .fn()
        .mockResolvedValueOnce([
          { connection_id: 'child-only', profile_id: 'a', wave_id: 'wave' },
          { connection_id: 'both', profile_id: 'b', wave_id: 'wave' }
        ])
        .mockResolvedValueOnce([
          { connection_id: 'both', profile_id: 'b', wave_id: 'wave' },
          { connection_id: 'parent-only', profile_id: 'c', wave_id: 'wave' }
        ]);
      const groupQuery = jest.fn().mockResolvedValue({ sql: '', params: {} });
      const repo = new WsConnectionRepository(
        () => ({ oneOrNull, execute }) as never,
        {
          getSqlAndParamsByGroupId: groupQuery,
          getSqlAndParamsByGroupIdForSystemBroadcast: groupQuery
        } as never
      );
      const method = system
        ? repo.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast.bind(
            repo
          )
        : repo.getCurrentlyOnlineCommunityMemberConnectionIds.bind(repo);
      await expect(
        method({ waveId: 'wave', groupId: null }, {})
      ).resolves.toEqual([
        { connectionId: 'both', profileId: 'b', wave_id: 'wave' }
      ]);
      expect(groupQuery.mock.calls.map((call) => call[0])).toEqual([
        'child',
        'parent-group'
      ]);
    }
  );

  it.each([
    null,
    { visibility_group_id: null, parent_wave_id: 'missing', parent_id: null },
    {
      visibility_group_id: null,
      parent_wave_id: 'parent',
      parent_id: 'parent',
      parent_parent_id: 'grandparent'
    }
  ])(
    'does not broadcast missing or invalid parent chains: %s',
    async (wave) => {
      const execute = jest.fn();
      const repo = new WsConnectionRepository(
        () =>
          ({ oneOrNull: jest.fn().mockResolvedValue(wave), execute }) as never,
        {} as never
      );
      await expect(
        repo.getCurrentlyOnlineCommunityMemberConnectionIds(
          { waveId: 'wave', groupId: null },
          {}
        )
      ).resolves.toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it('replaces the notification identities owned by a connection', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([{ connection_id: 'connection-1' }])
      .mockResolvedValue([]);
    const transactionConnection = { connection: {} };
    const executeNativeQueriesInTransaction = jest.fn(async (callback) =>
      callback(transactionConnection)
    );
    const repo = new WsConnectionRepository(
      () => ({ execute, executeNativeQueriesInTransaction }) as any,
      {} as any
    );

    await repo.replaceNotificationSubscriptions(
      'connection-1',
      [
        { identityId: 'profile-1', jwtExpiry: 123 },
        { identityId: 'profile-2', jwtExpiry: 456 }
      ],
      {}
    );

    expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
    expect(executeNativeQueriesInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: 'READ COMMITTED' }
    );
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0][0]).toContain(
      'order by identity_id for update'
    );
    expect(execute.mock.calls[0][2]).toEqual({
      wrappedConnection: transactionConnection,
      bindInvocationContext: true
    });
    expect(execute.mock.calls[1][0]).toContain(
      `delete from ${WS_NOTIFICATION_SUBSCRIPTIONS_TABLE}`
    );
    expect(execute.mock.calls[1][2]).toEqual({
      wrappedConnection: transactionConnection,
      bindInvocationContext: true
    });
    expect(execute.mock.calls[2][0]).toContain(
      `insert into ${WS_NOTIFICATION_SUBSCRIPTIONS_TABLE}`
    );
    expect(execute.mock.calls[2][0]).toContain(
      '(:connectionId, :identityId0, :jwtExpiry0), (:connectionId, :identityId1, :jwtExpiry1)'
    );
    expect(execute.mock.calls[2][1]).toEqual({
      connectionId: 'connection-1',
      identityId0: 'profile-1',
      jwtExpiry0: 123,
      identityId1: 'profile-2',
      jwtExpiry1: 456
    });
    expect(execute.mock.calls[2][2]).toEqual({
      wrappedConnection: transactionConnection,
      bindInvocationContext: true
    });
  });

  describe('typing-purpose sockets (0.12a)', () => {
    const purposeFilter = "(ws.purpose is null or ws.purpose <> 'TYPING')";

    it('inserts the purpose column only for sockets that declare one', async () => {
      const execute = jest.fn().mockResolvedValue([]);
      const repo = new WsConnectionRepository(
        () =>
          ({
            execute,
            executeNativeQueriesInTransaction: jest.fn(async (callback) =>
              callback({ connection: {} })
            )
          }) as any,
        {} as any
      );
      const base = {
        identity_id: 'profile-1',
        jwt_expiry: 123,
        wave_id: null
      };

      await repo.save(
        { ...base, connection_id: 'legacy', purpose: null },
        [],
        {}
      );
      await repo.save(
        {
          ...base,
          connection_id: 'typing',
          purpose: WsConnectionPurpose.TYPING
        },
        [],
        {}
      );

      const inserts = execute.mock.calls
        .map(([sql, params]) => ({ sql: String(sql), params }))
        .filter(({ sql }) =>
          sql.startsWith(`insert into ${WS_CONNECTIONS_TABLE}`)
        );
      expect(inserts).toHaveLength(2);
      expect(inserts[0].sql).not.toContain('purpose');
      expect(inserts[1].sql).toContain(
        '(connection_id, jwt_expiry, identity_id, purpose)'
      );
      expect(inserts[1].params).toMatchObject({
        connection_id: 'typing',
        purpose: WsConnectionPurpose.TYPING
      });
    });

    it.each([false, true])(
      'leaves typing sockets out of wave audiences unless asked (system=%s)',
      async (system) => {
        const oneOrNull = jest.fn().mockResolvedValue({
          visibility_group_id: null,
          parent_wave_id: null,
          parent_id: null,
          parent_parent_id: null,
          parent_group_id: null
        });
        const execute = jest.fn().mockResolvedValue([]);
        const repo = new WsConnectionRepository(
          () => ({ oneOrNull, execute }) as never,
          {} as never
        );
        const method = system
          ? repo.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast.bind(
              repo
            )
          : repo.getCurrentlyOnlineCommunityMemberConnectionIds.bind(repo);

        await method({ waveId: 'wave', groupId: null }, {});
        await method(
          { waveId: 'wave', groupId: null },
          {},
          { includeTypingSockets: true }
        );

        expect(execute.mock.calls[0][0]).toContain(purposeFilter);
        expect(execute.mock.calls[0][0]).toContain(
          '(ws.wave_id = :waveId or ws.wave_id is null)'
        );
        expect(execute.mock.calls[1][0]).not.toContain('ws.purpose');
      }
    );

    it('applies the filter to grouped wave audiences', async () => {
      const oneOrNull = jest.fn().mockResolvedValue({
        visibility_group_id: 'group',
        parent_wave_id: null,
        parent_id: null,
        parent_parent_id: null,
        parent_group_id: null
      });
      const execute = jest.fn().mockResolvedValue([]);
      const repo = new WsConnectionRepository(
        () => ({ oneOrNull, execute }) as never,
        {
          getSqlAndParamsByGroupId: jest
            .fn()
            .mockResolvedValue({ sql: 'with cm as (select 1)', params: {} })
        } as never
      );

      await repo.getCurrentlyOnlineCommunityMemberConnectionIds(
        { waveId: 'wave', groupId: null },
        {}
      );

      expect(execute.mock.calls[0][0]).toContain(`where ${purposeFilter}`);
    });

    it('leaves typing sockets out of identity and global lookups', async () => {
      const execute = jest.fn().mockResolvedValue([]);
      const repo = new WsConnectionRepository(
        () => ({ execute }) as never,
        {} as never
      );

      await repo.findConnectionIdsByIdentityId('profile-1');
      await repo.findPrimaryConnectionIdsByIdentityIds(['profile-1']);
      await repo.findNotificationConnectionIdsByIdentityIds(['profile-1']);
      await repo.findAllConnectionIds();

      for (const [sql] of execute.mock.calls) {
        expect(sql).toContain(purposeFilter);
      }
      expect(execute.mock.calls[2][0]).toContain(
        "(connections.purpose is null or connections.purpose <> 'TYPING')"
      );
    });
  });

  it('runs bounded deterministic stale cleanup only for sampled connections', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const shouldCleanup = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const repo = new WsConnectionRepository(
      () => ({ execute }) as any,
      {} as any,
      shouldCleanup
    );

    await repo.maybeCleanupStaleNotificationSubscriptions();
    expect(execute).not.toHaveBeenCalled();

    await repo.maybeCleanupStaleNotificationSubscriptions();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toContain(
      'where jwt_expiry <= unix_timestamp()'
    );
    expect(execute.mock.calls[0][0]).toContain('order by jwt_expiry asc');
    expect(execute.mock.calls[0][0]).toContain('limit 1000');
    expect(execute.mock.calls[1][0]).toContain('where not exists');
    expect(execute.mock.calls[1][0]).toContain(
      'order by connection_id, identity_id'
    );
    expect(execute.mock.calls[1][0]).toContain('limit 1000');
    expect(shouldCleanup).toHaveBeenCalledTimes(2);
  });

  it('finds active primary and extra-account notification subscriptions', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue([
        { connection_id: 'connection-1', identity_id: 'profile-1' }
      ]);
    const repo = new WsConnectionRepository(
      () => ({ execute }) as any,
      {} as any
    );

    await expect(
      repo.findNotificationConnectionIdsByIdentityIds([
        'profile-1',
        'profile-1'
      ])
    ).resolves.toEqual([
      { connectionId: 'connection-1', identityId: 'profile-1' }
    ]);

    expect(execute.mock.calls[0][0]).toContain(
      `from ${WS_NOTIFICATION_SUBSCRIPTIONS_TABLE}`
    );
    expect(execute.mock.calls[0][0]).toContain(
      'subscriptions.jwt_expiry > unix_timestamp()'
    );
    expect(execute.mock.calls[0][1]).toEqual({
      identityIds: ['profile-1']
    });
  });

  it('uses wave voting credit nft rows for CARD_SET_TDH credit-left queries', async () => {
    const oneOrNull = jest
      .fn()
      .mockResolvedValueOnce({
        credit_type: WaveCreditType.CARD_SET_TDH,
        credit_scope: WaveCreditScope.WAVE
      })
      .mockResolvedValueOnce({ cnt: 2 });
    const execute = jest.fn().mockResolvedValue([
      {
        profile_id: 'profile-1',
        credit_left: 5
      }
    ]);
    const repo = new WsConnectionRepository(
      () =>
        ({
          oneOrNull,
          execute
        }) as any,
      {} as any
    );

    const result = await repo.getCreditLeftForProfilesForTdhBasedWave({
      profileIds: ['profile-1'],
      waveId: 'wave-1'
    });

    expect(result).toEqual({
      'profile-1': 5
    });
    expect(oneOrNull).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(`from ${legacyGetView(WAVES_TABLE)}`),
      { waveId: 'wave-1' }
    );
    expect(oneOrNull).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        `from ${legacyGetView(WAVE_VOTING_CREDIT_NFTS_TABLE)}`
      ),
      { waveId: 'wave-1' }
    );
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain(`from ${legacyGetView(DROP_VOTER_STATE_TABLE)}`);
    expect(sql).toContain(`from ${IDENTITIES_TABLE}`);
    expect(sql).toContain(
      `join ${legacyGetView(WAVE_VOTING_CREDIT_NFTS_TABLE)} wvcn`
    );
    expect(sql).toContain(`left join ${TDH_NFT_TABLE} tn`);
    expect(params).toEqual(
      expect.objectContaining({
        waveId: 'wave-1',
        profileIds: ['profile-1']
      })
    );
  });

  it('throws an api-compliant error when a CARD_SET_TDH wave has no configured cards', async () => {
    const oneOrNull = jest
      .fn()
      .mockResolvedValueOnce({
        credit_type: WaveCreditType.CARD_SET_TDH,
        credit_scope: WaveCreditScope.WAVE
      })
      .mockResolvedValueOnce({ cnt: 0 });
    const repo = new WsConnectionRepository(
      () =>
        ({
          oneOrNull,
          execute: jest.fn()
        }) as any,
      {} as any
    );

    try {
      await repo.getCreditLeftForProfilesForTdhBasedWave({
        profileIds: ['profile-1'],
        waveId: 'wave-1'
      });
      fail('expected CARD_SET_TDH misconfiguration to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CustomApiCompliantException);
      expect(error).toMatchObject({
        message:
          'Wave wave-1 is misconfigured: CARD_SET_TDH requires voting credit nfts [configuredCardCount=0]'
      });
    }
  });

  it('logs a warning and returns zero credit for unexpected wave credit types', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const oneOrNull = jest.fn().mockResolvedValue({
      credit_type: WaveCreditType.REP,
      credit_scope: WaveCreditScope.WAVE
    });
    const repo = new WsConnectionRepository(
      () =>
        ({
          oneOrNull,
          execute: jest.fn()
        }) as any,
      {} as any
    );

    const result = await repo.getCreditLeftForProfilesForTdhBasedWave({
      profileIds: ['profile-1', 'profile-2'],
      waveId: 'wave-1'
    });

    expect(result).toEqual({
      'profile-1': 0,
      'profile-2': 0
    });
    expect(warn).toHaveBeenCalledWith(
      '[UNEXPECTED TDH CREDIT TYPE LOOKUP] [waveId=wave-1] [creditType=REP] [profileIds=profile-1,profile-2]'
    );
  });

  it('subtracts only the active drop vote when credit scope is DROP', async () => {
    const oneOrNull = jest.fn().mockResolvedValue({
      credit_type: WaveCreditType.TDH,
      credit_scope: WaveCreditScope.DROP
    });
    const execute = jest.fn().mockResolvedValue([
      {
        profile_id: 'profile-1',
        credit_left: 8
      }
    ]);
    const repo = new WsConnectionRepository(
      () =>
        ({
          oneOrNull,
          execute
        }) as any,
      {} as any
    );

    const result = await repo.getCreditLeftForProfilesForTdhBasedWave({
      profileIds: ['profile-1'],
      waveId: 'wave-1',
      dropId: 'drop-1'
    });

    expect(result).toEqual({
      'profile-1': 8
    });
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain(`drop_id = :dropId`);
    expect(params).toEqual({
      waveId: 'wave-1',
      dropId: 'drop-1',
      profileIds: ['profile-1']
    });
  });
});
