const connection = { connection: 'tx' };
const executeNativeQueriesInTransaction = jest.fn(async (work: any) =>
  work(connection)
);
const freezeForMint = jest.fn(async () => null);

jest.mock('@/sql-executor', () => ({
  ...jest.requireActual('@/sql-executor'),
  dbSupplier: () => ({ executeNativeQueriesInTransaction })
}));
jest.mock('@/meme-collaborations/meme-collaborations.service', () => ({
  memeCollaborationsService: { freezeForMint }
}));

import { claimBuildQueue } from './waves-chain-index.claims';

describe("claimBuildQueue's collaboration freeze", () => {
  beforeEach(() => {
    executeNativeQueriesInTransaction.mockClear();
    freezeForMint.mockClear();
  });

  it("freezes the drop's collaboration for the mint in one transaction, as the runtime does", async () => {
    await claimBuildQueue.freezeCollaboration!('drop-1');
    expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
    expect(freezeForMint).toHaveBeenCalledTimes(1);
    expect(freezeForMint).toHaveBeenCalledWith('drop-1', { connection });
  });

  it('throws when the freeze fails, so nothing is sent', async () => {
    freezeForMint.mockRejectedValueOnce(new Error('lock wait timeout'));
    await expect(
      claimBuildQueue.freezeCollaboration!('drop-1')
    ).rejects.toThrow('lock wait timeout');
  });
});
