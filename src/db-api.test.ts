import { addRememe } from '@/db-api';
import { sqlExecutor } from '@/sql-executor';

describe('addRememe', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists rememes when optional Alchemy metadata is missing', async () => {
    const executeSpy = jest.spyOn(sqlExecutor, 'execute').mockResolvedValue([]);

    await addRememe('0xsubmitter', {
      contract: {
        address: '0xcontract'
      },
      references: [1],
      nfts: [
        {
          tokenId: '1'
        }
      ]
    });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        contract: '0xcontract',
        token_id: '1',
        deployer: '',
        tokenUri: '',
        tokenType: '',
        image: '',
        animation: '',
        meme_references: '[1]',
        metadata: '{}',
        contract_opensea_data: '{}',
        media: '{}',
        added_by: '0xsubmitter'
      })
    );
  });
});
