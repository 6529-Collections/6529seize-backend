import { MEMES_CONTRACT, IDENTITIES_TABLE, TDH_NFT_TABLE } from '@/constants';
import { IdentitiesDb } from './identities.db';

describe('IdentitiesDb', () => {
  it('loads card-set voting credits through distinct profile consolidation keys', async () => {
    const execute = jest.fn().mockResolvedValue([
      {
        contract: MEMES_CONTRACT.toLowerCase(),
        token_id: 1,
        boosted_tdh: 7
      }
    ]);
    const repo = new IdentitiesDb(
      () =>
        ({
          execute
        }) as any
    );

    const result = await repo.getSingleNftVotingCreditsByProfileId(
      'profile-1',
      [{ contract: MEMES_CONTRACT.toLowerCase(), tokenId: 1 }],
      { timer: undefined }
    );

    expect(result).toEqual({
      [`${MEMES_CONTRACT.toLowerCase()}:1`]: 7
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain(`SELECT DISTINCT consolidation_key`);
    expect(sql).toContain(`FROM ${IDENTITIES_TABLE}`);
    expect(sql).toContain(`FROM ${TDH_NFT_TABLE} t`);
    expect(sql).toContain(`WHERE t.contract = :contract`);
    expect(sql).toContain(`AND t.id IN (:tokenIds)`);
    expect(sql).toContain(`ON i.consolidation_key = t.consolidation_key`);
    expect(params).toMatchObject({
      profileId: 'profile-1',
      contract: MEMES_CONTRACT.toLowerCase(),
      tokenIds: [1]
    });
  });
});
