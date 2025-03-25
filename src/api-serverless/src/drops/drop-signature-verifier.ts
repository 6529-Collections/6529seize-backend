import { ApiCreateDropRequest } from '../generated/models/ApiCreateDropRequest';
import { ethers } from 'ethers';
import { dropHasher, DropHasher } from './drop-hasher';

export class DropSignatureVerifier {
  constructor(private readonly dropHasher: DropHasher) {}

  public isDropSignedByAnyOfGivenWallets({
    wallets,
    drop,
    termsOfService
  }: {
    wallets: string[];
    drop: ApiCreateDropRequest;
    termsOfService: string | null;
  }): boolean {
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
    const signingAddress = this.getSigningAddress(hash, signature);
    if (!signingAddress) {
      return false;
    }
    return wallets.map((it) => it.toLowerCase()).includes(signingAddress);
  }

  private getSigningAddress(
    hash: string,
    clientSignature: string
  ): string | null {
    try {
      const signingAddress = ethers.utils
        .verifyMessage(hash, clientSignature)
        ?.toLowerCase();
      return signingAddress ?? null;
    } catch (e) {
      return null;
    }
  }
}

export const dropSignatureVerifier = new DropSignatureVerifier(dropHasher);
