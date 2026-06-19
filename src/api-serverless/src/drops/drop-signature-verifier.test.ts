import { ethers } from 'ethers';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { DropHasher } from '@/api/drops/drop-hasher';
import { DropSignatureVerifier } from '@/api/drops/drop-signature-verifier';
import {
  buildStructuredWalletSignatureMessage,
  clearStructuredWalletSignatureReplayCacheForTests
} from '@/api/wallet-signatures/structured-wallet-signatures';

const EIP1271_MAGIC_VALUE = '0x1626ba7e';
const EIP1271_INVALID_VALUE = '0xffffffff';

describe('DropSignatureVerifier', () => {
  const dropHasher = new DropHasher();
  const verifier = new DropSignatureVerifier(dropHasher);
  const wallet = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  );
  const otherWallet = new ethers.Wallet(
    '0x59c6995e998f97a5a0044966f094538e9d874d2fe3df31d0f01e3be7f0ca0a84'
  );
  const termsOfService = 'Terms accepted';
  let isValidSignatureMock: jest.Mock;

  beforeEach(() => {
    clearStructuredWalletSignatureReplayCacheForTests();
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS = 'example.com';
    process.env.ALCHEMY_API_KEY = 'test-key';
    isValidSignatureMock = jest.fn().mockResolvedValue(EIP1271_INVALID_VALUE);
    const contractConstructor = jest.fn().mockImplementation(() => ({
      isValidSignature: isValidSignatureMock
    }));
    jest
      .spyOn(ethers, 'Contract', 'get')
      .mockReturnValue(
        contractConstructor as unknown as typeof ethers.Contract
      );
  });

  afterEach(() => {
    delete process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS;
    delete process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED;
    delete process.env.ALCHEMY_API_KEY;
    jest.restoreAllMocks();
  });

  function createDrop(signerAddress = wallet.address): ApiCreateDropRequest {
    return {
      wave_id: 'wave-1',
      reply_to: undefined,
      drop_type: ApiDropType.Participatory,
      mentioned_groups: [],
      title: 'Signed drop',
      parts: [
        {
          content: 'Hello world',
          media: [],
          attachments: []
        }
      ],
      referenced_nfts: [],
      mentioned_users: [],
      mentioned_waves: [],
      metadata: [],
      signature: null,
      signer_address: signerAddress
    };
  }

  async function signDropAsText(
    drop: ApiCreateDropRequest
  ): Promise<ApiCreateDropRequest> {
    const hash = dropHasher.hash({ drop, termsOfService });
    return {
      ...drop,
      signature: await wallet.signMessage(hash)
    };
  }

  async function signDropAsRawHashBytes(
    drop: ApiCreateDropRequest
  ): Promise<ApiCreateDropRequest> {
    const hash = dropHasher.hash({ drop, termsOfService });
    return {
      ...drop,
      signature: await wallet.signMessage(ethers.getBytes(`0x${hash}`))
    };
  }

  async function signDropAsStructuredMessage(
    drop: ApiCreateDropRequest,
    domain = 'example.com'
  ): Promise<ApiCreateDropRequest & { signature_message: string }> {
    const hash = dropHasher.hash({ drop, termsOfService });
    const signatureMessage = buildStructuredWalletSignatureMessage({
      kind: 'action',
      domain,
      wallet: wallet.address,
      nonce: 'drop-nonce-1',
      action: 'create_drop',
      payloadHash: hash,
      purpose: 'Sign this message to create a 6529 drop.'
    });
    return {
      ...drop,
      signature: await wallet.signMessage(signatureMessage),
      signature_message: signatureMessage
    };
  }

  it('accepts current text hash signatures', async () => {
    const drop = await signDropAsText(createDrop());

    await expect(
      verifier.isDropSignedByAnyOfGivenWallets({
        wallets: [wallet.address],
        drop,
        termsOfService
      })
    ).resolves.toBe(true);
  });

  it('accepts raw hash byte signatures', async () => {
    const drop = await signDropAsRawHashBytes(createDrop());

    await expect(
      verifier.isDropSignedByAnyOfGivenWallets({
        wallets: [wallet.address],
        drop,
        termsOfService
      })
    ).resolves.toBe(true);
  });

  it('accepts structured drop signatures', async () => {
    const drop = await signDropAsStructuredMessage(createDrop());

    await expect(
      verifier.isDropSignedByAnyOfGivenWallets({
        wallets: [wallet.address],
        drop,
        termsOfService
      })
    ).resolves.toBe(true);
  });

  it('accepts structured drop signatures from unregistered client domains', async () => {
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS = '6529.io';
    const drop = await signDropAsStructuredMessage(
      createDrop(),
      'community-client.example'
    );

    await expect(
      verifier.isDropSignedByAnyOfGivenWallets({
        wallets: [wallet.address],
        drop,
        termsOfService
      })
    ).resolves.toBe(true);
  });

  it('accepts structured drop signatures using the message wallet when signer_address is omitted', async () => {
    const drop = await signDropAsStructuredMessage({
      ...createDrop(),
      signer_address: undefined
    });

    await expect(
      verifier.isDropSignedByAnyOfGivenWallets({
        wallets: [wallet.address],
        drop,
        termsOfService
      })
    ).resolves.toBe(true);
  });

  it('rejects legacy drop signatures when structured signatures are required', async () => {
    process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED = 'true';
    const drop = await signDropAsText(createDrop());

    await expect(
      verifier.isDropSignedByAnyOfGivenWallets({
        wallets: [wallet.address],
        drop,
        termsOfService
      })
    ).resolves.toBe(false);
  });

  it('rejects raw hash byte signatures when signer_address does not match', async () => {
    const drop = await signDropAsRawHashBytes(createDrop(otherWallet.address));

    await expect(
      verifier.isDropSignedByAnyOfGivenWallets({
        wallets: [wallet.address],
        drop,
        termsOfService
      })
    ).resolves.toBe(false);
  });

  it('accepts legacy EIP-1271 signatures even when the Safe hint is false', async () => {
    isValidSignatureMock.mockResolvedValue(EIP1271_MAGIC_VALUE);
    const contractWalletAddress = otherWallet.address;
    const drop = {
      ...createDrop(contractWalletAddress),
      is_safe_signature: false,
      signature: await wallet.signMessage('not-the-drop-hash')
    };

    await expect(
      verifier.isDropSignedByAnyOfGivenWallets({
        wallets: [contractWalletAddress],
        drop,
        termsOfService
      })
    ).resolves.toBe(true);
  });

  it('rejects signatures from wallets outside the candidate list', async () => {
    const drop = await signDropAsRawHashBytes(createDrop());

    await expect(
      verifier.isDropSignedByAnyOfGivenWallets({
        wallets: [otherWallet.address],
        drop,
        termsOfService
      })
    ).resolves.toBe(false);
  });
});
