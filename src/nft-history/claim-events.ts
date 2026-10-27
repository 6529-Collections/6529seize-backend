import { createHash } from 'node:crypto';
import { Interface, zeroPadValue } from 'ethers';
import { NFT_HISTORY_IFACE } from '@/abis/nft_history';
import {
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  MANIFOLD_LAZY_CLAIM_CONTRACT
} from '@/constants';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { Log } from '@/ethereum-rpc/ethereum-rpc-types';
import { NFTHistoryEventEntity } from '@/entities/INFTHistoryEvent';

// All ERC1155 claim generations, including the extension used by Meme #550.
// https://github.com/manifoldxyz/manifold-contract-addresses#erc1155-edition-formerly-known-as-claim
export const CLAIM_EXTENSIONS = [
  '0xca71c5270EFf44Eb6D813A92c0ba12577bDDf208',
  '0x4e32004D8b81847A670b4a1778ACe4dCF2bBA01E',
  '0x44e94034AFcE2Dd3CD5Eb62528f239686Fc8f162',
  '0xE7d3982E214F9DFD53d23a7f72851a7044072250',
  '0xDb8d79C775452a3929b86ac5DEaB3e9d38e1c006',
  '0x04bA6cf3c5AA6D4946F5B7f7ADF111012a9fAC65',
  MANIFOLD_LAZY_CLAIM_CONTRACT,
  '0x88438f4d4B8516E758a319ad16924DA60e1E56CC'
].map((address) => address.toLowerCase());

export const CLAIM_EVENT_IFACE = new Interface([
  'event ClaimUpdated(address indexed creatorContract, uint256 indexed instanceId)',
  'function getClaimForToken(address creatorContractAddress, uint256 tokenId) view returns (uint256)',
  'function updateTokenURIParams(address creatorContractAddress, uint256 instanceId, uint8 storageProtocol, string location)'
]);

export type ClaimEvent = Omit<
  NFTHistoryEventEntity,
  'description' | 'created_at'
>;

export function compareHistoryPosition(
  a: { block: number; transaction_index: number; log_index: number },
  b: { block: number; transaction_index: number; log_index: number }
) {
  return (
    a.block - b.block ||
    a.transaction_index - b.transaction_index ||
    a.log_index - b.log_index
  );
}

export function claimEventId(
  log: Pick<Log, 'transactionHash' | 'logIndex'>
): string {
  return createHash('sha256')
    .update(`ethereum:${log.transactionHash.toLowerCase()}:${log.logIndex}`)
    .digest('hex');
}

export async function discoverClaimUpdates(
  fromBlock: number,
  toBlock: number,
  audit = false
): Promise<Log[]> {
  const rpc = getEthereumRpcClient();
  const topic = CLAIM_EVENT_IFACE.getEvent('ClaimUpdated')!.topicHash;
  // Query by indexed creator as well as topic. Unknown emitters are reported by
  // replay instead of silently excluded from a historical coverage audit.
  const logs = await rpc.getLogs({
    ...(audit ? {} : { address: CLAIM_EXTENSIONS }),
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${toBlock.toString(16)}`,
    topics: [
      topic,
      [zeroPadValue(MEMES_CONTRACT, 32), zeroPadValue(MEMELAB_CONTRACT, 32)]
    ]
  });
  return logs.sort(
    (a, b) =>
      a.blockNumber - b.blockNumber ||
      a.transactionIndex - b.transactionIndex ||
      a.logIndex - b.logIndex
  );
}

export function claimMetadataUri(protocol: number, location: string): string {
  if (!location) throw new Error('Empty claim metadata location');
  if (protocol === 2) return `https://arweave.net/${location}`;
  if (protocol === 3) return `ipfs://${location}`;
  if (protocol === 1 && location.startsWith('https://')) return location;
  throw new Error(`Unsupported claim storage protocol: ${protocol}`);
}

export async function decodeClaimUpdate(
  log: Log,
  resolveClaim: (contract: string, claimId: string) => Promise<number[]>
): Promise<ClaimEvent> {
  if (log.removed || !CLAIM_EXTENSIONS.includes(log.address.toLowerCase())) {
    throw new Error(`Unverified or removed claim event: ${log.address}`);
  }
  const parsedLog = CLAIM_EVENT_IFACE.parseLog({
    topics: [...log.topics],
    data: log.data
  });
  if (parsedLog?.name !== 'ClaimUpdated')
    throw new Error('Invalid claim event');
  const contract = [MEMES_CONTRACT, MEMELAB_CONTRACT].find(
    (address) =>
      address.toLowerCase() ===
      String(parsedLog.args.creatorContract).toLowerCase()
  );
  if (!contract) throw new Error('Unsupported creator contract');
  const claimId = String(parsedLog.args.instanceId);
  const rpc = getEthereumRpcClient();
  const [tx, receipt, block] = await Promise.all([
    rpc.getTransaction(log.transactionHash),
    rpc.getTransactionReceipt(log.transactionHash),
    rpc.getBlock(log.blockNumber)
  ]);
  const receiptLog = receipt?.logs.find(
    (entry) => entry.index === log.logIndex
  );
  if (
    !tx ||
    receipt?.status !== 1 ||
    block.hash !== log.blockHash ||
    receipt.blockHash !== log.blockHash ||
    tx.blockHash !== log.blockHash ||
    tx.index !== log.transactionIndex ||
    receiptLog?.address.toLowerCase() !== log.address.toLowerCase() ||
    receiptLog.data !== log.data ||
    JSON.stringify(receiptLog.topics) !== JSON.stringify(log.topics)
  ) {
    throw new Error('Claim event receipt/canonical block mismatch');
  }
  // An event has no URI payload. Never substitute end-of-block/current state
  // for historical calldata: that loses intermediate edits in the same block.
  if (tx.to?.toLowerCase() !== log.address.toLowerCase())
    throw new Error(
      'Unsupported forwarded claim update; execution calldata required'
    );
  const parsedTx =
    NFT_HISTORY_IFACE.parseTransaction({ data: tx.data }) ??
    CLAIM_EVENT_IFACE.parseTransaction({ data: tx.data });
  if (
    !parsedTx ||
    !['updateClaim', 'updateTokenURIParams'].includes(parsedTx.name)
  )
    throw new Error('Unsupported claim update calldata');
  if (
    String(parsedTx.args.creatorContractAddress).toLowerCase() !==
      contract.toLowerCase() ||
    String(parsedTx.args.instanceId ?? parsedTx.args.claimIndex) !== claimId
  )
    throw new Error('Claim calldata/event mismatch');
  const parameters =
    parsedTx.name === 'updateClaim'
      ? parsedTx.args.claimParameters
      : parsedTx.args;
  const tokenIds = Array.from(new Set(await resolveClaim(contract, claimId)));
  if (
    tokenIds.length !== 1 ||
    !Number.isSafeInteger(tokenIds[0]) ||
    tokenIds[0] < 0
  )
    throw new Error(`Unmapped or ambiguous claim ${contract}/${claimId}`);
  const tokenId = tokenIds[0];
  // The stored mapping is creator-scoped; verify it against this extension to
  // reject collisions when another generation reused the same claim index.
  const result = await rpc.call(
    {
      to: log.address,
      data: CLAIM_EVENT_IFACE.encodeFunctionData('getClaimForToken', [
        contract,
        tokenId
      ])
    },
    log.blockNumber
  );
  if (
    !/^0x[0-9a-f]+$/i.test(result) ||
    (result.length - 2) % 64 !== 0 ||
    BigInt(`0x${result.slice(2, 66)}`).toString() !== claimId
  )
    throw new Error('Stored claim mapping does not match extension');
  return {
    event_id: claimEventId(log),
    contract,
    nft_id: tokenId,
    uri: claimMetadataUri(
      Number(parameters.storageProtocol),
      String(parameters.location)
    ),
    transaction_date: new Date(block.timestamp * 1000),
    transaction_hash: log.transactionHash,
    block_hash: log.blockHash,
    extension: log.address.toLowerCase(),
    claim_id: claimId,
    block: log.blockNumber,
    transaction_index: log.transactionIndex,
    log_index: log.logIndex
  };
}
