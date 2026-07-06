// Manifold ERC1155 lazy-claim extension contract used by The Memes mints.
// Shared by every consumer that reads claim state on-chain so the address
// and ABI cannot drift between services.
export const MANIFOLD_LAZY_CLAIM_CONTRACT =
  '0x26BBEA7803DcAc346D5F5f135b57Cf2c752A02bE';

export const MANIFOLD_LAZY_CLAIM_ABI = [
  'function getClaimForToken(address creatorContractAddress, uint256 tokenId) view returns (uint256 instanceId, tuple(uint32 total, uint32 totalMax, uint32 walletMax, uint48 startDate, uint48 endDate, uint8 storageProtocol, bytes32 merkleRoot, string location, uint256 tokenId, uint256 cost, address payable paymentReceiver, address erc20, address signingAddress) claim)'
];
