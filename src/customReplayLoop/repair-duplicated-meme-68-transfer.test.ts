import {
  classifyProdTdhRepairSnapshot,
  ProdTdhRepairSnapshot
} from './repair-duplicated-meme-68-transfer';

type SnapshotValues = {
  transactionCount: number;
  recipientOwnerBalance: number;
  recipientConsolidatedBalance: number;
};

const NEEDS_REPAIR: SnapshotValues = {
  transactionCount: 2,
  recipientOwnerBalance: 2,
  recipientConsolidatedBalance: 2
};

const REPAIRED: SnapshotValues = {
  transactionCount: 1,
  recipientOwnerBalance: 1,
  recipientConsolidatedBalance: 1
};

function snapshot(values: SnapshotValues): ProdTdhRepairSnapshot {
  const tokenValue = (value: number) => [{ tokenId: 68, value }];
  return {
    transactions: tokenValue(values.transactionCount),
    senderOwners: [],
    recipientOwners: tokenValue(values.recipientOwnerBalance),
    recipientConsolidatedOwners: tokenValue(values.recipientConsolidatedBalance)
  };
}

describe('classifyProdTdhRepairSnapshot', () => {
  it('recognizes the exact production state that needs repair', () => {
    expect(classifyProdTdhRepairSnapshot(snapshot(NEEDS_REPAIR))).toBe(
      'needs-repair'
    );
  });

  it('recognizes an already repaired state', () => {
    expect(classifyProdTdhRepairSnapshot(snapshot(REPAIRED))).toBe(
      'already-repaired'
    );
  });

  it('rejects a partial repair', () => {
    const partial = snapshot({
      ...NEEDS_REPAIR,
      recipientOwnerBalance: REPAIRED.recipientOwnerBalance
    });

    expect(() => classifyProdTdhRepairSnapshot(partial)).toThrow(
      '[RECIPIENT OWNER] Expected token 68 value 2, found 1'
    );
  });

  it('rejects a missing target row', () => {
    const missing = {
      ...snapshot(NEEDS_REPAIR),
      transactions: []
    };

    expect(() => classifyProdTdhRepairSnapshot(missing)).toThrow(
      '[TRANSACTION] Expected 1 row, found 0'
    );
  });

  it('rejects an unexpected duplicate target row', () => {
    const duplicateTransaction = {
      ...snapshot(NEEDS_REPAIR),
      transactions: [
        { tokenId: 68, value: 2 },
        { tokenId: 68, value: 2 }
      ]
    };

    expect(() => classifyProdTdhRepairSnapshot(duplicateTransaction)).toThrow(
      '[TRANSACTION] Expected 1 row, found 2'
    );
  });

  it('rejects an unexpected token', () => {
    const wrongToken = {
      ...snapshot(NEEDS_REPAIR),
      recipientOwners: [{ tokenId: 69, value: 2 }]
    };

    expect(() => classifyProdTdhRepairSnapshot(wrongToken)).toThrow(
      '[RECIPIENT OWNER] Expected token 68, found 69'
    );
  });

  it('rejects unexpected positive sender ownership', () => {
    const unexpectedSenderOwner = {
      ...snapshot(NEEDS_REPAIR),
      senderOwners: [{ tokenId: 68, value: 1 }]
    };

    expect(() => classifyProdTdhRepairSnapshot(unexpectedSenderOwner)).toThrow(
      '[SENDER OWNERS] Expected no positive owner rows, found 1'
    );
  });
});
