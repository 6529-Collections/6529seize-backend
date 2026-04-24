import {
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  IDENTITIES_TABLE,
  TDH_NFT_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { DropsDb } from './drops.db';

describe('DropsDb', () => {
  it('uses wave voting credit nft rows when finding CARD_SET_TDH overvoters', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new DropsDb(
      () =>
        ({
          execute
        }) as any
    );

    const result =
      await repo.findTdhBasedSubmissionDropOvervotersWithOvervoteAmounts({
        timer: undefined
      });

    expect(result).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(4);
    const [sql] = execute.mock.calls[3];
    expect(sql).toContain(`from ${DROP_VOTER_STATE_TABLE}`);
    expect(sql).toContain(`join ${DROPS_TABLE}`);
    expect(sql).toContain(`from ${IDENTITIES_TABLE}`);
    expect(sql).toContain(`join ${WAVES_TABLE} w`);
    expect(sql).toContain(`join ${WAVE_VOTING_CREDIT_NFTS_TABLE} wvcn`);
    expect(sql).toContain(`left join ${TDH_NFT_TABLE} tn`);
    expect(sql).toContain(`CARD_SET_TDH`);
  });
});
