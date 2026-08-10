import { updateMintingClaimIfEditable } from '@/api/minting-claims/api.minting-claims.db';
import { sqlExecutor } from '@/sql-executor';

jest.mock('@/sql-executor', () => ({
  sqlExecutor: {
    execute: jest.fn()
  }
}));

describe('updateMintingClaimIfEditable', () => {
  const executeMock = sqlExecutor.execute as jest.MockedFunction<
    typeof sqlExecutor.execute
  >;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('atomically compares the stored attributes when replacing them', async () => {
    executeMock.mockResolvedValue([0, 1] as never);
    const expectedAttributes = JSON.stringify([
      { trait_type: 'Type - Season', value: 15 }
    ]);

    const updated = await updateMintingClaimIfEditable(
      '0xABC',
      123,
      {
        attributes: [{ trait_type: 'Type - Season', value: 15 }],
        metadata_location: null
      },
      expectedAttributes
    );

    expect(updated).toBe(true);
    expect(executeMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'AND attributes <=> CAST(:expectedAttributes AS JSON)'
      ),
      expect.objectContaining({
        contract: '0xabc',
        claimId: 123,
        expectedAttributes
      })
    );
    expect(executeMock.mock.calls[0]?.[0]).toContain(
      'AND COALESCE(media_uploading, 0) = 0'
    );
  });

  it('reports a failed compare-and-swap when no row matches', async () => {
    executeMock.mockResolvedValue([0, 0] as never);

    await expect(
      updateMintingClaimIfEditable('0xabc', 123, { name: 'Updated' }, '[]')
    ).resolves.toBe(false);
  });

  it('does not couple non-attribute patches to the stored attributes', async () => {
    executeMock.mockResolvedValue([0, 1] as never);

    await expect(
      updateMintingClaimIfEditable('0xabc', 123, { name: 'Updated' })
    ).resolves.toBe(true);

    expect(executeMock.mock.calls[0]?.[0]).not.toContain(
      'CAST(:expectedAttributes AS JSON)'
    );
    expect(executeMock.mock.calls[0]?.[1]).not.toHaveProperty(
      'expectedAttributes'
    );
  });
});
