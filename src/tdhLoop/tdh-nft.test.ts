import { persistNftTdh } from '@/db';
import { ConsolidatedTDH } from '@/entities/ITDH';
import { updateNftTDH } from './tdh_nft';

jest.mock('@/db', () => ({
  persistNftTdh: jest.fn()
}));

const mockedPersistNftTdh = persistNftTdh as jest.MockedFunction<
  typeof persistNftTdh
>;

describe('updateNftTDH', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes exact consolidation keys through partial persistence', async () => {
    const tdh = {
      consolidation_key: 'a-b',
      boost: 1,
      memes: [],
      memes_ranks: [],
      gradients: [],
      gradients_ranks: [],
      nextgen: [],
      nextgen_ranks: []
    } as unknown as ConsolidatedTDH;

    await updateNftTDH([tdh], ['a', 'b'], ['a-c', 'b']);

    expect(mockedPersistNftTdh).toHaveBeenCalledWith(
      [],
      ['a', 'b'],
      ['a-c', 'b']
    );
  });
});
