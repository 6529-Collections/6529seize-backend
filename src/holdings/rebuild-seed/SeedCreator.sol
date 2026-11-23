// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

/**
 * A test fixture of the rebuild check. It stands for a Manifold ERC-1155
 * creator contract on the check's private anvil, and only the holdings
 * seed (holdings-seed.ts) loads it, at the Memes, Meme Lab and Gradient
 * addresses. Written for this repository, under its Apache-2.0 license,
 * from the contract's public interface (function signatures and events);
 * no code is taken from Manifold's sources.
 *
 * It keeps only what the holdings loops read: new tokens with their URIs
 * (`mintBaseNew`), a token URI change (`setTokenURI`, which emits no event,
 * as on Manifold), paid mints of an existing token, an extension's new and
 * existing mints (`mintExtensionNew`, `mintExtensionExisting`, called by
 * SeedClaim), transfers, `uri` and `tokenURI`. An extension's new token
 * takes the URI it passes; Manifold's would ask the extension. Storage
 * starts empty, so the first `mintBaseNew` makes token 1.
 *
 * Build, from this directory, into seed-creator.runtime.ts:
 *   solc --optimize --evm-version paris --no-cbor-metadata --bin-runtime SeedCreator.sol
 */
contract SeedCreator {
    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 value
    );

    mapping(uint256 => mapping(address => uint256)) public balanceOf;
    mapping(uint256 => string) private uris;
    uint256 private lastId;

    function mintBaseNew(
        address[] calldata to,
        uint256[] calldata amounts,
        string[] calldata newUris
    ) external returns (uint256[] memory ids) {
        require(to.length == 1, "One recipient");
        require(amounts.length == newUris.length, "Lengths");
        ids = new uint256[](newUris.length);
        for (uint256 i = 0; i < newUris.length; i++) {
            uint256 id = ++lastId;
            uris[id] = newUris[i];
            ids[i] = id;
            _mint(to[0], id, amounts[i]);
        }
    }

    function setTokenURI(uint256 tokenId, string calldata uri_) external {
        require(bytes(uris[tokenId]).length > 0, "Invalid token");
        uris[tokenId] = uri_;
    }

    function mintExtensionNew(
        address[] calldata to,
        uint256[] calldata amounts,
        string[] calldata newUris
    ) external returns (uint256[] memory ids) {
        require(to.length == 1 && amounts.length == newUris.length, "Lengths");
        ids = new uint256[](newUris.length);
        for (uint256 i = 0; i < newUris.length; i++) {
            uint256 id = ++lastId;
            uris[id] = newUris[i];
            ids[i] = id;
            _mint(to[0], id, amounts[i]);
        }
    }

    function mintExtensionExisting(
        address[] calldata to,
        uint256[] calldata tokenIds,
        uint256[] calldata amounts
    ) external {
        require(to.length == tokenIds.length && to.length == amounts.length, "Lengths");
        for (uint256 i = 0; i < to.length; i++) {
            require(bytes(uris[tokenIds[i]]).length > 0, "Invalid token");
            _mint(to[i], tokenIds[i], amounts[i]);
        }
    }

    /** A collector's paid mint of an existing token, as a claim would make it. */
    function mintExisting(uint256 id, uint256 amount) external payable {
        require(bytes(uris[id]).length > 0, "Invalid token");
        _mint(msg.sender, id, amount);
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata
    ) external {
        require(from == msg.sender, "Not owner");
        require(balanceOf[id][from] >= amount, "Balance");
        balanceOf[id][from] -= amount;
        balanceOf[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
    }

    function uri(uint256 id) external view returns (string memory) {
        require(bytes(uris[id]).length > 0, "Invalid token");
        return uris[id];
    }

    function tokenURI(uint256 id) external view returns (string memory) {
        require(bytes(uris[id]).length > 0, "URI query for nonexistent token");
        return uris[id];
    }

    function _mint(address to, uint256 id, uint256 amount) private {
        balanceOf[id][to] += amount;
        emit TransferSingle(msg.sender, address(0), to, id, amount);
    }
}
