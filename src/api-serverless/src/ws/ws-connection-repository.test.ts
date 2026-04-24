import {
  DROP_VOTER_STATE_TABLE,
  IDENTITIES_TABLE,
  TDH_NFT_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { WaveCreditType } from '@/entities/IWave';
import { WsConnectionRepository } from './ws-connection.repository';

describe('WsConnectionRepository', () => {
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
});
