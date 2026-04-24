import {
  DROP_VOTER_STATE_TABLE,
  IDENTITIES_TABLE,
  TDH_NFT_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { WaveCreditType } from '@/entities/IWave';
import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import { WsConnectionRepository } from './ws-connection.repository';

describe('WsConnectionRepository', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses wave voting credit nft rows for CARD_SET_TDH credit-left queries', async () => {
    const oneOrNull = jest
      .fn()
      .mockResolvedValueOnce({
        credit_type: WaveCreditType.CARD_SET_TDH
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
    expect(params).toEqual({
      waveId: 'wave-1',
      profileIds: ['profile-1']
    });
  });

  it('throws an api-compliant error when a CARD_SET_TDH wave has no configured cards', async () => {
    const oneOrNull = jest
      .fn()
      .mockResolvedValueOnce({
        credit_type: WaveCreditType.CARD_SET_TDH
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
      credit_type: WaveCreditType.REP
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
});
