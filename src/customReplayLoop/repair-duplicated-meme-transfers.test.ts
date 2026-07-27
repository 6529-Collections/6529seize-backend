import {
  classifyProdTdhRepairSnapshot,
  ProdTdhRepairSnapshot
} from './repair-duplicated-meme-transfers';

function snapshot(value: number): ProdTdhRepairSnapshot {
  const rows = [
    { tokenId: 135, value },
    { tokenId: 254, value }
  ];
  return {
    transactions: rows,
    recipientOwners: rows,
    recipientConsolidatedOwners: rows,
    senderOwners: []
  };
}

describe('classifyProdTdhRepairSnapshot', () => {
  it('recognizes the exact production state that needs repair', () => {
    expect(classifyProdTdhRepairSnapshot(snapshot(2))).toBe('needs-repair');
  });

  it('recognizes an already repaired state', () => {
    expect(classifyProdTdhRepairSnapshot(snapshot(1))).toBe('already-repaired');
  });

  it('rejects a partial repair', () => {
    const partial: ProdTdhRepairSnapshot = {
      ...snapshot(2),
      recipientOwners: [
        { tokenId: 135, value: 1 },
        { tokenId: 254, value: 2 }
      ]
    };

    expect(() => classifyProdTdhRepairSnapshot(partial)).toThrow(
      '[RECIPIENT OWNERS] Expected token 135 value 2, found 1'
    );
  });

  it('rejects missing target rows', () => {
    const missing: ProdTdhRepairSnapshot = {
      ...snapshot(2),
      transactions: [{ tokenId: 135, value: 2 }]
    };

    expect(() => classifyProdTdhRepairSnapshot(missing)).toThrow(
      '[TRANSACTIONS] Expected 2 rows, found 1'
    );
  });

  it('rejects unexpected positive sender ownership', () => {
    const unexpectedSenderOwner: ProdTdhRepairSnapshot = {
      ...snapshot(2),
      senderOwners: [{ tokenId: 135, value: 1 }]
    };

    expect(() => classifyProdTdhRepairSnapshot(unexpectedSenderOwner)).toThrow(
      '[SENDER OWNERS] Expected no positive owner rows, found 1'
    );
  });
});
