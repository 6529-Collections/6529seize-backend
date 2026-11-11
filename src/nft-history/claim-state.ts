import { AbiCoder, Interface } from 'ethers';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { CLAIM_EXTENSIONS, claimMetadataUri } from './claim-events';

const COMMON_CLAIM =
  'uint32 total,uint32 totalMax,uint32 walletMax,uint48 startDate,uint48 endDate,uint8 storageProtocol,bytes32 merkleRoot,string location,uint256 tokenId,uint256 cost,address paymentReceiver';
const CLAIM_CALL = new Interface([
  'function getClaim(address,uint256) view returns (bytes)'
]);

export const DEFERRED_CLAIM_EXTENSION =
  '0x44e94034afce2dd3cd5eb62528f239686fc8f162';

export interface VerifiedClaim {
  tokenId: number;
  total: string;
  location: string;
  uri: string;
}

export async function readHistoryClaim(
  extension: string,
  contract: string,
  claimId: string,
  block: number,
  allowUnassigned = false
): Promise<VerifiedClaim> {
  if (!CLAIM_EXTENSIONS.includes(extension.toLowerCase()))
    throw new Error(`Unverified claim extension: ${extension}`);
  const raw = await getEthereumRpcClient().call(
    {
      to: extension,
      data: CLAIM_CALL.encodeFunctionData('getClaim', [contract, claimId])
    },
    block
  );
  if (!/^0x[0-9a-f]+$/i.test(raw) || (raw.length - 2) % 64 !== 0)
    throw new Error('Malformed historical claim response');
  // getClaim returns one dynamic tuple. Validate its head before decoding: the
  // deployed generations have 11, 12 or 13 fields, not interchangeable tails.
  const outerOffset = BigInt(`0x${raw.slice(2, 66)}`);
  const stringOffset = Number(BigInt(`0x${raw.slice(2 + 8 * 64, 2 + 9 * 64)}`));
  const extra = new Map([
    [352, ''],
    [384, ',address erc20'],
    [416, ',address erc20,address signingAddress']
  ]).get(stringOffset);
  if (outerOffset !== BigInt(32) || extra === undefined)
    throw new Error('Unsupported historical claim layout');
  const claim = AbiCoder.defaultAbiCoder().decode(
    [`tuple(${COMMON_CLAIM}${extra})`],
    raw
  )[0];
  const unassigned =
    allowUnassigned &&
    extension.toLowerCase() === DEFERRED_CLAIM_EXTENSION &&
    claim.tokenId === (BigInt(1) << BigInt(256)) - BigInt(1);
  const tokenId = unassigned ? -1 : Number(claim.tokenId);
  if (
    !unassigned &&
    (!Number.isSafeInteger(tokenId) || tokenId < 0 || tokenId > 2147483647)
  )
    throw new Error('Claim token ID is outside the history storage range');
  return {
    tokenId,
    total: String(claim.total),
    location: String(claim.location),
    uri: claimMetadataUri(Number(claim.storageProtocol), String(claim.location))
  };
}
