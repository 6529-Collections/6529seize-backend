// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

/**
 * Test fixtures of the rebuild check. They stand for the NextGen core and
 * minter contracts on the check's private anvil, and only the holdings
 * seed (holdings-seed.ts) loads them, at the NextGen addresses in
 * nextgen_constants.ts. Written for this repository, under its Apache-2.0
 * license, from the contracts' public interface (function signatures and
 * events); no code is taken from NextGen's sources.
 *
 * The NextGen loop reads their calldata with the real contracts' ABI, so
 * each function a transaction calls has the real signature; the bodies keep
 * only what the loop reads back: Transfer events, owners and each token's
 * data. Each contract's first storage slot holds the other's address, which
 * the seed sets when it installs them.
 *
 * Build, from this directory, into seed-nextgen.runtime.ts:
 *   solc --optimize --via-ir --evm-version paris --no-cbor-metadata --bin-runtime SeedNextGen.sol
 */
contract SeedNextGenCore {
    event Transfer(
        address indexed from,
        address indexed to,
        uint256 indexed tokenId
    );

    /** Slot 0: the minter, the only caller of `mint`. */
    address private minter;

    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => string) public tokenData;
    mapping(uint256 => uint256) private mintedIn;
    uint256 public newCollectionIndex;

    function createCollection(
        string memory,
        string memory,
        string memory,
        string memory,
        string memory,
        string memory,
        string memory,
        bytes32,
        string[] memory
    ) external {
        newCollectionIndex++;
    }

    function setCollectionData(
        uint256,
        address,
        uint256,
        uint256,
        uint256
    ) external {}

    /** Called by the minter only, as on the real core. */
    function mint(
        uint256,
        address,
        address _mintTo,
        string memory _tokenData,
        uint256,
        uint256 _collectionID,
        uint256
    ) external {
        require(msg.sender == minter, "Minter only");
        uint256 tokenId = _collectionID * 10_000_000_000 + mintedIn[_collectionID]++;
        ownerOf[tokenId] = _mintTo;
        tokenData[tokenId] = _tokenData;
        emit Transfer(address(0), _mintTo, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId)
        external
    {
        require(from == msg.sender && ownerOf[tokenId] == from, "Not owner");
        ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }
}

interface ISeedNextGenCore {
    function mint(
        uint256 mintIndex,
        address _mintingAddress,
        address _mintTo,
        string memory _tokenData,
        uint256 _saltfun_o,
        uint256 _collectionID,
        uint256 phase
    ) external;
}

contract SeedNextGenMinter {
    /** Slot 0: the core, which makes the tokens. */
    address private core;

    function setCollectionPhases(
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        bytes32
    ) external {}

    /** A public-phase mint: the core makes the tokens. */
    function mint(
        uint256 _collectionID,
        uint256 _numberOfTokens,
        uint256,
        string memory _tokenData,
        address _mintTo,
        bytes32[] calldata,
        address,
        uint256 _saltfun_o
    ) external payable {
        for (uint256 i = 0; i < _numberOfTokens; i++) {
            ISeedNextGenCore(core).mint(
                0,
                msg.sender,
                _mintTo,
                _tokenData,
                _saltfun_o,
                _collectionID,
                2
            );
        }
    }
}
