import {
  classifyProdTdhRepairSnapshot,
  ProdTdhRepairSnapshot
} from './repair-duplicated-meme-transfers';

type SnapshotValues = {
  transactionCount: number;
  senderOwnerBalance: number;
  recipientOwnerBalance: number;
  senderConsolidatedBalance: number;
  recipientConsolidatedBalance: number;
};

const NEEDS_REPAIR: SnapshotValues = {
  transactionCount: 2,
  senderOwnerBalance: 1,
  recipientOwnerBalance: 2,
  senderConsolidatedBalance: 33,
  recipientConsolidatedBalance: 2
};

const REPAIRED: SnapshotValues = {
  transactionCount: 1,
  senderOwnerBalance: 2,
  recipientOwnerBalance: 1,
  senderConsolidatedBalance: 34,
  recipientConsolidatedBalance: 1
};

function snapshot(values: SnapshotValues): ProdTdhRepairSnapshot {
  const tokenValue = (value: number) => [{ tokenId: 473, value }];
  return {
    transactions: tokenValue(values.transactionCount),
    senderOwners: tokenValue(values.senderOwnerBalance),
    recipientOwners: tokenValue(values.recipientOwnerBalance),
    senderConsolidatedOwners: tokenValue(values.senderConsolidatedBalance),
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
      senderOwnerBalance: REPAIRED.senderOwnerBalance
    });

    expect(() => classifyProdTdhRepairSnapshot(partial)).toThrow(
      '[SENDER OWNER] Expected token 473 value 1, found 2'
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
        { tokenId: 473, value: 2 },
        { tokenId: 473, value: 2 }
      ]
    };

    expect(() => classifyProdTdhRepairSnapshot(duplicateTransaction)).toThrow(
      '[TRANSACTION] Expected 1 row, found 2'
    );
  });

  it('rejects an unexpected recipient consolidation balance', () => {
    const unexpected = snapshot({
      ...NEEDS_REPAIR,
      recipientConsolidatedBalance: 3
    });

    expect(() => classifyProdTdhRepairSnapshot(unexpected)).toThrow(
      '[RECIPIENT CONSOLIDATED OWNER] Expected token 473 value 2, found 3'
    );
  });
});
