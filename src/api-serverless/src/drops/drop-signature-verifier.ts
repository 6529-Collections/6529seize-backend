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
    const signingAddresses = await this.getSigningAddresses({
      hash,
      clientSignature: signature,
      isSafeSignature: drop.is_safe_signature,
      signerAddress: drop.signer_address
    });
    const walletSet = new Set(wallets.map((it) => it.toLowerCase()));
    return signingAddresses.some((signingAddress) =>
      walletSet.has(signingAddress)
    );
  }

  private async getSigningAddresses({
    hash,
    clientSignature,
    signerAddress,
    isSafeSignature
  }: {
    hash: string;
    clientSignature: string;
    isSafeSignature?: boolean;
    signerAddress?: string;
  }): Promise<string[]> {
    try {
      if (isSafeSignature) {
        if (!signerAddress) {
          return [];
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
          return [signerAddress.toLowerCase()];
        }
        return [];
      }
      return this.filterBySignerAddress({
        signerAddress,
        signingAddresses: [
          this.recoverTextSigningAddress({ hash, clientSignature }),
          this.recoverRawHashBytesSigningAddress({ hash, clientSignature })
        ]
      });
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
      return ethers.verifyMessage(hash, clientSignature)?.toLowerCase() ?? null;
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
      return (
        ethers
          .verifyMessage(ethers.getBytes(`0x${hash}`), clientSignature)
          ?.toLowerCase() ?? null
      );
    } catch {
      return null;
    }
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
