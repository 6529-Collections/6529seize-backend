import { ApiCreateDropRequest } from '../generated/models/ApiCreateDropRequest';
import { ethers } from 'ethers';
import { dropHasher, DropHasher } from './drop-hasher';
import { env } from '../../../env';

export class DropSignatureVerifier {
  constructor(private readonly dropHasher: DropHasher) {}

  public async isDropSignedByAnyOfGivenWallets({
    wallets,
    drop,
    termsOfService
  }: {
    wallets: string[];
    drop: ApiCreateDropRequest;
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
    const signingAddress = await this.getSigningAddress({
      hash,
      clientSignature: signature,
      isSafeSignature: drop.is_safe_signature,
      signerAddress: drop.signer_address
    });
    if (!signingAddress) {
      return false;
    }
    return wallets.map((it) => it.toLowerCase()).includes(signingAddress);
  }

  private async getSigningAddress({
    hash,
    clientSignature,
    signerAddress,
    isSafeSignature
  }: {
    hash: string;
    clientSignature: string;
    isSafeSignature?: boolean;
    signerAddress?: string;
  }): Promise<string | null> {
    try {
      if (isSafeSignature) {
        if (!signerAddress) {
          return null;
        }

        const EIP1271_ABI = [
          'function isValidSignature(bytes32 _messageHash, bytes _signature) public view returns (bytes4)'
        ];

        const provider = new ethers.JsonRpcProvider(
          `https://eth-mainnet.alchemyapi.io/v2/${env.getStringOrThrow(`ALCHEMY_API_KEY`)}`
        );
        const safeContract = new ethers.Contract(
          signerAddress,
          EIP1271_ABI,
          provider
        );
        const result = await safeContract.isValidSignature(
          hash,
          clientSignature
        );
        const MAGIC_VALUE = '0x1626ba7e';

        if (result === MAGIC_VALUE) {
          return signerAddress?.toLowerCase();
        } else {
          return null;
        }
      }
      const signingAddress = ethers
        .verifyMessage(hash, clientSignature)
        ?.toLowerCase();
      if (signerAddress && signingAddress !== signerAddress?.toLowerCase()) {
        return null;
      }
      return signingAddress ?? null;
    } catch (e) {
      return null;
    }
  }
}

export const dropSignatureVerifier = new DropSignatureVerifier(dropHasher);
