// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

/**
 * A test fixture of the rebuild check. It stands for Manifold's ERC-1155
 * lazy claim extension on the check's private anvil, and only the holdings
 * seed (holdings-seed.ts) loads it, at MANIFOLD_LAZY_CLAIM_CONTRACT.
 * Written for this repository, under its Apache-2.0 license, from the
 * extension's public interface (function signatures, events and the
 * getClaim layout); no code is taken from Manifold's sources.
 *
 * It keeps what the holdings loops and NFT history read: initializeClaim
 * and mint with the real signatures (history decodes their calldata), the
 * ClaimInitialized event, and getClaim and getClaimForToken in the latest
 * deployed layout (13 fields). The claim's token is a new token on the
 * creator (SeedCreator's mintExtensionNew), its URI the Arweave location.
 *
 * Build, from this directory, into seed-claim.runtime.ts:
 *   solc --optimize --via-ir --evm-version paris --no-cbor-metadata --bin-runtime SeedClaim.sol
 */
interface ISeedCreator {
    function mintExtensionNew(
        address[] calldata to,
        uint256[] calldata amounts,
        string[] calldata uris
    ) external returns (uint256[] memory);

    function mintExtensionExisting(
        address[] calldata to,
        uint256[] calldata tokenIds,
        uint256[] calldata amounts
    ) external;
}

contract SeedClaim {
    struct ClaimParameters {
        uint32 totalMax;
        uint32 walletMax;
        uint48 startDate;
        uint48 endDate;
        uint8 storageProtocol;
        bytes32 merkleRoot;
        string location;
        uint256 cost;
        address payable paymentReceiver;
        address erc20;
        address signingAddress;
    }

    struct Claim {
        uint32 total;
        uint32 totalMax;
        uint32 walletMax;
        uint48 startDate;
        uint48 endDate;
        uint8 storageProtocol;
        bytes32 merkleRoot;
        string location;
        uint256 tokenId;
        uint256 cost;
        address payable paymentReceiver;
        address erc20;
        address signingAddress;
    }

    event ClaimInitialized(
        address indexed creatorContract,
        uint256 indexed instanceId,
        address initializer
    );

    mapping(address => mapping(uint256 => Claim)) private claims;
    mapping(address => mapping(uint256 => uint256)) private claimOfToken;

    /** Arweave (storage protocol 2): the token's URI names the location. */
    function initializeClaim(
        address creatorContractAddress,
        uint256 instanceId,
        ClaimParameters calldata p
    ) external {
        require(claims[creatorContractAddress][instanceId].tokenId == 0, "Exists");
        address[] memory to = new address[](1);
        to[0] = msg.sender;
        uint256[] memory amounts = new uint256[](1);
        string[] memory uris = new string[](1);
        uris[0] = string(abi.encodePacked("https://arweave.net/", p.location));
        uint256 tokenId = ISeedCreator(creatorContractAddress).mintExtensionNew(
            to,
            amounts,
            uris
        )[0];
        claims[creatorContractAddress][instanceId] = Claim(
            0,
            p.totalMax,
            p.walletMax,
            p.startDate,
            p.endDate,
            p.storageProtocol,
            p.merkleRoot,
            p.location,
            tokenId,
            p.cost,
            p.paymentReceiver,
            p.erc20,
            p.signingAddress
        );
        claimOfToken[creatorContractAddress][tokenId] = instanceId;
        emit ClaimInitialized(creatorContractAddress, instanceId, msg.sender);
    }

    function mint(
        address creatorContractAddress,
        uint256 instanceId,
        uint32,
        bytes32[] calldata,
        address mintFor
    ) external payable {
        Claim storage claim = claims[creatorContractAddress][instanceId];
        require(claim.tokenId != 0 && msg.value == claim.cost, "Cost");
        claim.total++;
        address[] memory to = new address[](1);
        to[0] = mintFor;
        uint256[] memory ids = new uint256[](1);
        ids[0] = claim.tokenId;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1;
        ISeedCreator(creatorContractAddress).mintExtensionExisting(to, ids, amounts);
        (bool paid, ) = claim.paymentReceiver.call{value: msg.value}("");
        require(paid, "Payment");
    }

    function getClaim(address creatorContractAddress, uint256 instanceId)
        external
        view
        returns (Claim memory)
    {
        return claims[creatorContractAddress][instanceId];
    }

    function getClaimForToken(address creatorContractAddress, uint256 tokenId)
        external
        view
        returns (uint256 instanceId, Claim memory claim)
    {
        instanceId = claimOfToken[creatorContractAddress][tokenId];
        claim = claims[creatorContractAddress][instanceId];
        require(claim.tokenId == tokenId && tokenId != 0, "Claim not initialized");
    }
}
