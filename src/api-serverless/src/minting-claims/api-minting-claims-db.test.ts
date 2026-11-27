import {
  updateMintingClaimIfEditable,
  updateMintingClaimIfNotUploading
} from '@/api/minting-claims/api.minting-claims.db';
import { sqlExecutor } from '@/sql-executor';

jest.mock('@/sql-executor', () => ({
  sqlExecutor: {
    execute: jest.fn(),
    executeNativeQueriesInTransaction: jest.fn()
  }
}));

describe('updateMintingClaimIfEditable', () => {
  const executeMock = sqlExecutor.execute as jest.MockedFunction<
    typeof sqlExecutor.execute
  >;
  const transactionMock =
    sqlExecutor.executeNativeQueriesInTransaction as jest.MockedFunction<
      typeof sqlExecutor.executeNativeQueriesInTransaction
    >;
  const connection = { connection: {} };

  beforeEach(() => {
    jest.clearAllMocks();
    transactionMock.mockImplementation(async (callback) =>
      callback(connection)
    );
  });

  it('atomically compares the stored attributes when replacing them', async () => {
    executeMock
      .mockResolvedValueOnce([{ claim_id: 123 }])
      .mockResolvedValueOnce([]);
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
    expect(executeMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        'AND attributes <=> CAST(:expectedAttributes AS JSON)'
      ),
      expect.objectContaining({
        contract: '0xabc',
        claimId: 123,
        expectedAttributes
      }),
      { wrappedConnection: connection }
    );
    expect(executeMock.mock.calls[0]?.[0]).toContain(
      'AND COALESCE(media_uploading, 0) = 0'
    );
    expect(executeMock.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(executeMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE minting_claims'),
      expect.any(Object),
      { wrappedConnection: connection }
    );
  });

  it('reports a failed compare-and-swap when no row matches', async () => {
    executeMock.mockResolvedValue([]);

    await expect(
      updateMintingClaimIfEditable('0xabc', 123, { name: 'Updated' }, '[]')
    ).resolves.toBe(false);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('does not couple non-attribute patches to the stored attributes', async () => {
    executeMock
      .mockResolvedValueOnce([{ claim_id: 123 }])
      .mockResolvedValueOnce([]);

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

describe('explicit claim publication retry', () => {
  it('resets recovery budgets without discarding signed transactions', async () => {
    jest
      .mocked(sqlExecutor.execute)
      .mockResolvedValueOnce({ affectedRows: 1 } as never);
    await expect(
      updateMintingClaimIfNotUploading('0xabc', 1, { media_uploading: true })
    ).resolves.toBe(true);
    const query = jest.mocked(sqlExecutor.execute).mock.calls.at(-1)![0];
    expect(query).toContain('CASE WHEN media_upload_state IS NULL THEN NULL');
    expect(query).toContain('ELSE JSON_SET(media_upload_state');
    expect(query).toContain("'$.failures', 0");
    expect(query).toContain("'$.newRequest', CAST('true' AS JSON)");
    expect(query).not.toContain('media_upload_state = NULL');
    expect(query).toContain('COALESCE(media_uploading, 0) = 0');
  });
});
