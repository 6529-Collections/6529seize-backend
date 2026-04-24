import { NFTS_TABLE } from '@/constants';
import { RequestContext } from '@/request.context';
import { WavesApiDb } from './waves.api.db';

describe('WavesApiDb card set credit nft lookup', () => {
  it('checks grouped contracts in a single query', async () => {
    const execute = jest.fn().mockResolvedValue([
      { contract: '0x111', token_id: 1 },
      { contract: '0x111', token_id: 2 },
      { contract: '0x222', token_id: 9 }
    ]);
    const repo = new WavesApiDb(
      () =>
        ({
          execute
        }) as any
    );

    const result = await repo.findExistingCardSetCreditNftKeys(
      [
        { contract: '0x111', tokenId: 2 },
        { contract: '0x222', tokenId: 9 },
        { contract: '0x111', tokenId: 1 }
      ],
      { timer: undefined } as RequestContext
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain(`FROM ${NFTS_TABLE}`);
    expect(sql).toContain('(contract = :contract0 AND id IN (:tokenIds0))');
    expect(sql).toContain('(contract = :contract1 AND id IN (:tokenIds1))');
    expect(params).toEqual({
      contract0: '0x111',
      tokenIds0: [1, 2],
      contract1: '0x222',
      tokenIds1: [9]
    });
    expect(result).toEqual(new Set(['0x111:1', '0x111:2', '0x222:9']));
  });
});
