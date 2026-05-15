import { ethers } from 'ethers';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { DropHasher } from '@/api/drops/drop-hasher';
import { DropSignatureVerifier } from '@/api/drops/drop-signature-verifier';

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
