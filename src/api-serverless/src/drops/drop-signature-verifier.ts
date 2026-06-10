import { ApiCreateDropRequest } from '../generated/models/ApiCreateDropRequest';
import { ethers } from 'ethers';
import { dropHasher, DropHasher } from './drop-hasher';
import {
  ETHEREUM_MAINNET_CHAIN_ID,
  hashWalletSignatureMessage,
  isStructuredSignaturesRequired,
  parseStructuredWalletSignatureMessage,
  recoverWalletMessageSigner,
  verifyContractWalletSignatureHash,
  verifyStructuredWalletSignature
} from '../wallet-signatures/structured-wallet-signatures';

type StructuredDropSignatureRequest = ApiCreateDropRequest & {
  signature_message?: string | null;
};

export class DropSignatureVerifier {
  constructor(private readonly dropHasher: DropHasher) {}

  public async isDropSignedByAnyOfGivenWallets({
    wallets,
    drop,
    termsOfService
  }: {
    wallets: string[];
    drop: StructuredDropSignatureRequest;
    termsOfService: string | null;
  }): Promise<boolean> {
    if (!wallets.length) {
      return false;
    }

    const signature = drop.signature;
    if (!signature) {
      return false;
    }
    const hash = this.dropHasher.hash({
      drop,
      termsOfService
    });
    const structuredMessage = drop.signature_message ?? null;
    if (structuredMessage) {
      const expectedAddress = this.getStructuredSigningAddress(
        structuredMessage,
        drop.signer_address
      );
      if (!expectedAddress) {
        return false;
      }
      const signingAddress = await verifyStructuredWalletSignature({
        message: structuredMessage,
        signature,
        expectedAddress,
        expectedChainId: ETHEREUM_MAINNET_CHAIN_ID,
        expectedAction: 'create_drop',
        expectedKind: 'action',
        expectedPayloadHash: hash
      });
      if (!signingAddress) {
        return false;
      }
      const walletSet = new Set(wallets.map((it) => it.toLowerCase()));
      return walletSet.has(signingAddress);
    }

    if (isStructuredSignaturesRequired()) {
      return false;
    }

    const signingAddresses = await this.getSigningAddresses({
      hash,
      clientSignature: signature,
      signerAddress: drop.signer_address,
      candidateWallets: wallets
    });
    const walletSet = new Set(wallets.map((it) => it.toLowerCase()));
    return signingAddresses.some((signingAddress) =>
      walletSet.has(signingAddress)
    );
  }

  private getStructuredSigningAddress(
    structuredMessage: string,
    signerAddress?: string
  ): string | null {
    if (signerAddress) {
      return signerAddress;
    }
    return (
      parseStructuredWalletSignatureMessage(structuredMessage)?.wallet ?? null
    );
  }

  private async getSigningAddresses({
    hash,
    clientSignature,
    signerAddress,
    candidateWallets
  }: {
    hash: string;
    clientSignature: string;
    signerAddress?: string;
    candidateWallets: string[];
  }): Promise<string[]> {
    try {
      const signingAddresses = this.filterBySignerAddress({
        signerAddress,
        signingAddresses: [
          this.recoverTextSigningAddress({ hash, clientSignature }),
          this.recoverRawHashBytesSigningAddress({ hash, clientSignature })
        ]
      });
      const seen = new Set(signingAddresses);
      const contractWalletCandidates = this.getContractWalletCandidates({
        signerAddress,
        candidateWallets
      });
      for (const candidateAddress of contractWalletCandidates) {
        if (seen.has(candidateAddress)) {
          continue;
        }
        const contractSignatureMatches =
          await this.isLegacyContractWalletDropSignature({
            address: candidateAddress,
            hash,
            clientSignature
          });
        if (contractSignatureMatches) {
          signingAddresses.push(candidateAddress);
          seen.add(candidateAddress);
        }
      }
      return signingAddresses;
    } catch {
      return [];
    }
  }

  private recoverTextSigningAddress({
    hash,
    clientSignature
  }: {
    hash: string;
    clientSignature: string;
  }): string | null {
    try {
      return recoverWalletMessageSigner(hash, clientSignature);
    } catch {
      return null;
    }
  }

  private recoverRawHashBytesSigningAddress({
    hash,
    clientSignature
  }: {
    hash: string;
    clientSignature: string;
  }): string | null {
    try {
      return recoverWalletMessageSigner(
        ethers.getBytes(this.toBytes32Hex(hash)),
        clientSignature
      );
    } catch {
      return null;
    }
  }

  private async isLegacyContractWalletDropSignature({
    address,
    hash,
    clientSignature
  }: {
    address: string;
    hash: string;
    clientSignature: string;
  }): Promise<boolean> {
    const rawHash = this.toBytes32Hex(hash);
    const candidateHashes = new Set([
      rawHash,
      hashWalletSignatureMessage(hash),
      hashWalletSignatureMessage(ethers.getBytes(rawHash))
    ]);
    for (const messageHash of Array.from(candidateHashes)) {
      const isValid = await verifyContractWalletSignatureHash({
        address,
        chainId: ETHEREUM_MAINNET_CHAIN_ID,
        messageHash,
        signature: clientSignature
      });
      if (isValid) {
        return true;
      }
    }
    return false;
  }

  private getContractWalletCandidates({
    signerAddress,
    candidateWallets
  }: {
    signerAddress?: string;
    candidateWallets: string[];
  }): string[] {
    if (signerAddress) {
      const normalizedSignerAddress = this.normalizeAddress(signerAddress);
      return normalizedSignerAddress ? [normalizedSignerAddress] : [];
    }
    const candidates = new Set<string>();
    for (const wallet of candidateWallets) {
      const normalized = this.normalizeAddress(wallet);
      if (normalized) {
        candidates.add(normalized);
      }
    }
    return Array.from(candidates);
  }

  private normalizeAddress(address: string): string | null {
    return ethers.isAddress(address) ? address.toLowerCase() : null;
  }

  private toBytes32Hex(hash: string): string {
    return hash.startsWith('0x') ? hash : `0x${hash}`;
  }

  private filterBySignerAddress({
    signerAddress,
    signingAddresses
  }: {
    signerAddress?: string;
    signingAddresses: (string | null)[];
  }): string[] {
    const signerAddressLowerCase = signerAddress?.toLowerCase();
    return signingAddresses.reduce<string[]>((acc, signingAddress) => {
      if (!signingAddress) {
        return acc;
      }
      if (signerAddressLowerCase && signingAddress !== signerAddressLowerCase) {
        return acc;
      }
      if (!acc.includes(signingAddress)) {
        acc.push(signingAddress);
      }
      return acc;
    }, []);
  }
}

export const dropSignatureVerifier = new DropSignatureVerifier(dropHasher);
