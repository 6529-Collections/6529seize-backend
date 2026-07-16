import {
  DROP_VOTER_STATE_TABLE,
  IDENTITIES_TABLE,
  TDH_NFT_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  WAVES_TABLE,
  WS_NOTIFICATION_SUBSCRIPTIONS_TABLE
} from '@/constants';
import { WaveCreditScope, WaveCreditType } from '@/entities/IWave';
import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import { WsConnectionRepository } from './ws-connection.repository';

describe('WsConnectionRepository', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('replaces the notification identities owned by a connection', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new WsConnectionRepository(
      () => ({ execute }) as any,
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

    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0][0]).toContain(
      `delete from ${WS_NOTIFICATION_SUBSCRIPTIONS_TABLE}`
    );
    expect(execute.mock.calls[1][1]).toEqual({
      connectionId: 'connection-1',
      identityId: 'profile-1',
      jwtExpiry: 123
    });
    expect(execute.mock.calls[2][1]).toEqual({
      connectionId: 'connection-1',
      identityId: 'profile-2',
      jwtExpiry: 456
    });
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
      expect.stringContaining(`from ${WAVES_TABLE}`),
      { waveId: 'wave-1' }
    );
    expect(oneOrNull).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(`from ${WAVE_VOTING_CREDIT_NFTS_TABLE}`),
      { waveId: 'wave-1' }
    );
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain(`from ${DROP_VOTER_STATE_TABLE}`);
    expect(sql).toContain(`from ${IDENTITIES_TABLE}`);
    expect(sql).toContain(`join ${WAVE_VOTING_CREDIT_NFTS_TABLE} wvcn`);
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
