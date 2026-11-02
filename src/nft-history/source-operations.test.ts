import { AbiCoder } from 'ethers';
import {
  MEMES_CONTRACT,
  MEMELAB_CONTRACT,
  MANIFOLD_LAZY_CLAIM_CONTRACT
} from '@/constants';
import { NFT_HISTORY_IFACE } from '@/abis/nft_history';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import {
  HISTORY_SOURCE_IFACE,
  HistoryTransaction
} from './history-transactions';
import { decodeHistorySource } from './source-operations';

jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn()
}));
const wallet = '0x0187c9a182736ba18b44ee8134ee438374cf87dc';
const location = 'IFosq_ZN9_PrDSQmq65JTjeB2GnnfPSFoHxRazxC4PY';
const claimType =
  'tuple(uint32 total,uint32 totalMax,uint32 walletMax,uint48 startDate,uint48 endDate,uint8 storageProtocol,bytes32 merkleRoot,string location,uint256 tokenId,uint256 cost,address paymentReceiver,address erc20,address signingAddress)';
const zero = '0x' + '0'.repeat(40);
function encodedClaim(tokenId = 569, total = 0) {
  return AbiCoder.defaultAbiCoder().encode(
    [claimType],
    [
      [
        total,
        500,
        0,
        0,
        0,
        2,
        '0x' + '0'.repeat(64),
        location,
        tokenId,
        0,
        wallet,
        zero,
        zero
      ]
    ]
  );
}
function fixture(
  contract = MEMES_CONTRACT,
  tokenId = 569,
  amount = 0,
  data?: string
) {
  const transfer = HISTORY_SOURCE_IFACE.encodeEventLog(
    HISTORY_SOURCE_IFACE.getEvent('TransferSingle')!,
    [MANIFOLD_LAZY_CLAIM_CONTRACT, zero, wallet, tokenId, amount]
  );
  const raw = {
    ...transfer,
    address: contract,
    index: 1,
    blockNumber: 100,
    blockHash: '0xblock',
    transactionHash: '0xtx',
    transactionIndex: 2,
    removed: false
  };
  const tx = {
    hash: '0xtx',
    to: MANIFOLD_LAZY_CLAIM_CONTRACT,
    from: wallet,
    blockNumber: 100,
    index: 2,
    blockHash: '0xblock',
    data:
      data ??
      NFT_HISTORY_IFACE.encodeFunctionData('airdrop', [
        contract,
        12345,
        [wallet],
        [amount]
      ])
  };
  const receipt = {
    status: 1,
    blockHash: '0xblock',
    blockNumber: 100,
    index: 2,
    logs: [raw]
  };
  const rpc = {
    getTransaction: jest.fn(async () => tx),
    getTransactionReceipt: jest.fn(async () => receipt),
    getBlock: jest.fn(async () => ({
      number: 100,
      hash: '0xblock',
      timestamp: 1000
    })),
    call: jest.fn(async (_call: unknown, block: number) =>
      encodedClaim(tokenId, block === 99 ? 0 : amount)
    ),
    getLogs: jest.fn(async () => [])
  };
  jest
    .mocked(getEthereumRpcClient)
    .mockReturnValue(rpc as unknown as ReturnType<typeof getEthereumRpcClient>);
  const { index: _index, ...log } = raw;
  const source: HistoryTransaction = {
    hash: '0xtx',
    block: 100,
    transactionIndex: 2,
    logs: [{ ...log, logIndex: 1 }]
  };
  return { tx, receipt, rpc, raw, source };
}

it.each([MEMES_CONTRACT, MEMELAB_CONTRACT])(
  'maps a non-deployer initialization from receipt/token evidence on %s, not claim ID',
  async (contract) => {
    const { source, receipt, tx } = fixture(contract, 569);
    const initialized = HISTORY_SOURCE_IFACE.encodeEventLog(
      HISTORY_SOURCE_IFACE.getEvent(
        'ClaimInitialized(address,uint256,address)'
      )!,
      [contract, 12345, wallet]
    );
    receipt.logs.push({
      ...receipt.logs[0],
      ...initialized,
      address: MANIFOLD_LAZY_CLAIM_CONTRACT,
      index: 2
    });
    tx.data = NFT_HISTORY_IFACE.encodeFunctionData('0x809e7c37', [
      contract,
      12345,
      [500, 0, 0, 0, 2, '0x' + '0'.repeat(64), location, 0, wallet, zero, zero]
    ]);
    const operations = await decodeHistorySource(source, {
      hasMint: async () => false
    });
    expect(operations).toEqual([
      {
        kind: 'claim',
        claim: { contract, claimId: '12345', tokenId: 569, location }
      }
    ]);
  }
);

it('recovers the first positive airdrop from another wallet and keeps later airdrops out of Timeline', async () => {
  const { source } = fixture(MEMES_CONTRACT, 569, 20);
  const operations = await decodeHistorySource(source, {
    hasMint: async () => false
  });
  expect(operations.map((operation) => operation.kind)).toEqual([
    'claim',
    'mint'
  ]);
  expect(operations[1]).toEqual(
    expect.objectContaining({
      row: expect.objectContaining({
        nft_id: 569,
        uri: `https://arweave.net/${location}`,
        description: { event: 'Mint', changes: [] }
      })
    })
  );
  expect(
    await decodeHistorySource(source, { hasMint: async () => true })
  ).toEqual([]);
});

it('does not invent a later Mint when earlier positive supply exists but its history is missing', async () => {
  const { source, rpc } = fixture(MEMES_CONTRACT, 569, 20);
  rpc.call.mockImplementation(async () => encodedClaim(569, 20));
  await expect(
    decodeHistorySource(source, { hasMint: async () => false })
  ).rejects.toThrow('Earlier Mint baseline is missing');
});

it('does not substitute a later same-block metadata version for the Mint URI', async () => {
  const { source, rpc } = fixture(MEMES_CONTRACT, 569, 20);
  const earlier = HISTORY_SOURCE_IFACE.encodeEventLog(
    HISTORY_SOURCE_IFACE.getEvent('ClaimUpdated')!,
    [MEMES_CONTRACT, 12345]
  );
  const updateTx = {
    ...fixture().tx,
    index: 1,
    data: NFT_HISTORY_IFACE.encodeFunctionData('0xe505bb01', [
      MEMES_CONTRACT,
      12345,
      [
        500,
        0,
        0,
        0,
        2,
        '0x' + '0'.repeat(64),
        'earlier-uri',
        0,
        wallet,
        zero,
        zero
      ]
    ])
  };
  rpc.getTransaction.mockImplementation(async (hash?: string) =>
    hash === 'previous'
      ? updateTx
      : {
          ...updateTx,
          index: 2,
          data: NFT_HISTORY_IFACE.encodeFunctionData('airdrop', [
            MEMES_CONTRACT,
            12345,
            [wallet],
            [20]
          ])
        }
  );
  rpc.getLogs.mockResolvedValueOnce([
    {
      ...earlier,
      blockHash: updateTx.blockHash,
      transactionHash: 'previous',
      transactionIndex: 1,
      logIndex: 1
    }
  ] as never);
  // fixture() above changed the mock provider; restore this transaction's transport.
  jest
    .mocked(getEthereumRpcClient)
    .mockReturnValue(rpc as unknown as ReturnType<typeof getEthereumRpcClient>);
  const operations = await decodeHistorySource(source, {
    hasMint: async () => false
  });
  expect(operations.find((operation) => operation.kind === 'mint')).toEqual(
    expect.objectContaining({
      row: expect.objectContaining({ uri: 'https://arweave.net/earlier-uri' })
    })
  );
});

it('processes every token in a direct multi-token mint from any sender', async () => {
  const data = NFT_HISTORY_IFACE.encodeFunctionData('mintBaseNew', [
    [wallet, wallet],
    [1, 2],
    ['uri-a', 'uri-b']
  ]);
  const { tx, source, receipt } = fixture(MEMES_CONTRACT, 10, 1, data);
  tx.to = MEMES_CONTRACT;
  const second = HISTORY_SOURCE_IFACE.encodeEventLog(
    HISTORY_SOURCE_IFACE.getEvent('TransferSingle')!,
    [wallet, zero, wallet, 20, 2]
  );
  receipt.logs.push({ ...receipt.logs[0], ...second, index: 2 });
  const operations = await decodeHistorySource(source, {
    hasMint: async () => false
  });
  expect(
    operations
      .filter((operation) => operation.kind === 'mint')
      .map((operation) => operation.row.uri)
  ).toEqual(['uri-a', 'uri-b']);
});

it('decodes TransferBatch values by position when creating a first Mint', async () => {
  const { source, receipt } = fixture(MEMES_CONTRACT, 569, 20);
  const batch = HISTORY_SOURCE_IFACE.encodeEventLog(
    HISTORY_SOURCE_IFACE.getEvent('TransferBatch')!,
    [MANIFOLD_LAZY_CLAIM_CONTRACT, zero, wallet, [569], [20]]
  );
  Object.assign(receipt.logs[0], batch);
  Object.assign(source.logs[0], batch);
  const operations = await decodeHistorySource(source, {
    hasMint: async () => false
  });
  expect(
    operations.filter((operation) => operation.kind === 'mint')
  ).toHaveLength(1);
});

it('recognizes a preceding positive TransferBatch instead of inventing a later Mint', async () => {
  const { source, rpc, raw } = fixture(MEMES_CONTRACT, 569, 20);
  const batch = HISTORY_SOURCE_IFACE.encodeEventLog(
    HISTORY_SOURCE_IFACE.getEvent('TransferBatch')!,
    [MANIFOLD_LAZY_CLAIM_CONTRACT, zero, wallet, [569], [20]]
  );
  rpc.getLogs
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      { ...raw, ...batch, logIndex: 0, transactionIndex: 1 }
    ] as never);
  await expect(
    decodeHistorySource(source, { hasMint: async () => false })
  ).rejects.toThrow('Earlier Mint baseline is missing');
});

it('rejects reorged/changed receipts and failed source transactions', async () => {
  const { receipt, source } = fixture();
  receipt.blockHash = 'other';
  await expect(
    decodeHistorySource(source, { hasMint: async () => false })
  ).rejects.toThrow('mismatch');
  receipt.blockHash = '0xblock';
  receipt.status = 0;
  await expect(
    decodeHistorySource(source, { hasMint: async () => false })
  ).rejects.toThrow('Failed transaction');
  expect(
    await decodeHistorySource(
      { ...source, logs: [] },
      { hasMint: async () => false }
    )
  ).toEqual([]);
});

it('discovers a direct URI change by its creator target without requiring an admin sender', async () => {
  const { source, tx, receipt } = fixture();
  receipt.logs = [];
  source.logs = [];
  tx.to = MEMES_CONTRACT;
  tx.data = NFT_HISTORY_IFACE.encodeFunctionData('setTokenURI', [
    569,
    'ipfs://changed'
  ]);
  const operations = await decodeHistorySource(source, {
    hasMint: async () => true
  });
  expect(operations).toEqual([
    expect.objectContaining({
      kind: 'edit',
      event: expect.objectContaining({
        nft_id: 569,
        uri: 'ipfs://changed',
        log_index: -1
      })
    })
  ]);
});

it('records a non-deployer burn/redeem initialization from its verified creator mint receipt', async () => {
  const data = NFT_HISTORY_IFACE.encodeFunctionData('initializeBurnRedeem', [
    MEMELAB_CONTRACT,
    12345,
    [wallet, 2, 1, 100, 0, 0, 0, location, []]
  ]);
  const { source } = fixture(MEMELAB_CONTRACT, 61, 0, data);
  const operations = await decodeHistorySource(source, {
    hasMint: async () => false
  });
  expect(operations).toEqual([
    expect.objectContaining({
      kind: 'mint',
      row: expect.objectContaining({
        contract: MEMELAB_CONTRACT,
        nft_id: 61,
        uri: `https://arweave.net/${location}`
      })
    })
  ]);
});

it('does not cover an unsupported URI event with another creator token sharing its ID', async () => {
  const { source, receipt } = fixture(MEMES_CONTRACT, 569, 20);
  const uri = HISTORY_SOURCE_IFACE.encodeEventLog(
    HISTORY_SOURCE_IFACE.getEvent('URI')!,
    ['ipfs://other-creator', 569]
  );
  const raw = {
    ...receipt.logs[0],
    ...uri,
    address: MEMELAB_CONTRACT,
    index: 2
  };
  receipt.logs.push(raw);
  const { index: _index, ...log } = raw;
  source.logs.push({ ...log, logIndex: 2 });
  await expect(
    decodeHistorySource(source, { hasMint: async () => false })
  ).rejects.toThrow('Unsupported URI update');
});

it.each(['ClaimUpdated', 'ClaimInitialized(address,uint256,address)'])(
  'ignores unrelated forged %s receipt logs but reports them when explicitly audited',
  async (name) => {
    const { source, receipt } = fixture(MEMES_CONTRACT, 569, 20);
    const forged = HISTORY_SOURCE_IFACE.encodeEventLog(
      HISTORY_SOURCE_IFACE.getEvent(name)!,
      name === 'ClaimUpdated'
        ? [MEMES_CONTRACT, 999]
        : [MEMES_CONTRACT, 999, wallet]
    );
    const raw = { ...receipt.logs[0], ...forged, address: wallet, index: 2 };
    receipt.logs.push(raw);
    const reader = { hasMint: () => Promise.resolve(false) };
    const operations = await decodeHistorySource(source, reader);
    expect(operations.map((operation) => operation.kind)).toEqual([
      'claim',
      'mint'
    ]);
    const { index: _index, ...log } = raw;
    source.logs.push({ ...log, logIndex: 2 });
    await expect(decodeHistorySource(source, reader)).rejects.toThrow(
      'Unverified claim extension'
    );
  }
);

it('ignores malformed claim-signature logs from unrelated receipt emitters before ABI parsing', async () => {
  const { source, receipt } = fixture(MEMES_CONTRACT, 569, 20);
  receipt.logs.push({
    ...receipt.logs[0],
    address: wallet,
    index: 2,
    topics: [HISTORY_SOURCE_IFACE.getEvent('ClaimUpdated')!.topicHash],
    data: '0x'
  });
  const operations = await decodeHistorySource(source, {
    hasMint: () => Promise.resolve(false)
  });
  expect(operations.map((operation) => operation.kind)).toEqual([
    'claim',
    'mint'
  ]);
});
