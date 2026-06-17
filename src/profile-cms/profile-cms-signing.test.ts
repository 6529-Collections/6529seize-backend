import {
  buildProfileCmsPublishTypedData,
  Eip1271SignatureVerifier,
  ProfileCmsPublishSignatureRequest,
  ProfileCmsPublishTypedDataMessage,
  verifyProfileCmsPublishSignature
} from '@/profile-cms/profile-cms-signing';
import { Wallet, ZeroAddress } from 'ethers';

describe('profile CMS publish signing', () => {
  const wallet = new Wallet(
    '0x59c6995e998f97a5a0044966f094538f3b2e6ef43e1d18b1d4b6b0403d5c6b6a'
  );
  const requestBase: Omit<ProfileCmsPublishSignatureRequest, 'signature'> = {
    signer_address: wallet.address,
    chain_id: 1,
    deadline: 1792345678000
  };
  const message: ProfileCmsPublishTypedDataMessage = {
    action: 'publish',
    profileId: 'profile-1',
    handle: 'punk6529bot',
    packageId: 'profile-native-home',
    version: 1,
    draftId: 'draft-1',
    payloadHash: `sha256:${'1'.repeat(64)}`,
    packageHash: `sha256:${'2'.repeat(64)}`,
    primaryPath: '/punk6529bot/index.html',
    storageProvider: 'ipfs',
    storageUri: 'ipfs://bafybeigdyrztmrgfydgytzqojqfaytmqmvqwxqk66xcs4i6hj5yq',
    storageContentHash: `sha256:${'2'.repeat(64)}`,
    deadline: 1792345678000
  };

  it('verifies an EOA EIP-712 publish signature', async () => {
    const typedData = buildProfileCmsPublishTypedData({
      request: { ...requestBase, signature: '0x' },
      message
    });
    const signature = await wallet.signTypedData(
      typedData.domain,
      typedData.types,
      typedData.message
    );

    await expect(
      verifyProfileCmsPublishSignature({
        request: { ...requestBase, signature },
        message
      })
    ).resolves.toMatchObject({
      valid: true,
      signer_address: wallet.address.toLowerCase()
    });
  });

  it('rejects a signature when the signed package hash changes', async () => {
    const typedData = buildProfileCmsPublishTypedData({
      request: { ...requestBase, signature: '0x' },
      message
    });
    const signature = await wallet.signTypedData(
      typedData.domain,
      typedData.types,
      typedData.message
    );

    await expect(
      verifyProfileCmsPublishSignature({
        request: { ...requestBase, signature },
        message: { ...message, packageHash: `sha256:${'3'.repeat(64)}` }
      })
    ).resolves.toMatchObject({
      valid: false
    });
  });

  it('verifies an EOA signature when verifying_contract is in the domain', async () => {
    const request = {
      ...requestBase,
      verifying_contract: ZeroAddress,
      signature: '0x'
    };
    const typedData = buildProfileCmsPublishTypedData({
      request,
      message
    });
    const signature = await wallet.signTypedData(
      typedData.domain,
      typedData.types,
      typedData.message
    );

    await expect(
      verifyProfileCmsPublishSignature({
        request: { ...request, signature },
        message
      })
    ).resolves.toMatchObject({
      valid: true,
      typed_data: {
        domain: expect.objectContaining({
          verifyingContract: ZeroAddress
        })
      }
    });
  });

  it('supports EIP-1271 verification through an injected verifier', async () => {
    const verifier: Eip1271SignatureVerifier = {
      hasContractCode: jest.fn().mockResolvedValue(true),
      isValidSignature: jest.fn().mockResolvedValue(true)
    };

    await expect(
      verifyProfileCmsPublishSignature(
        {
          request: {
            ...requestBase,
            signature: '0xsafe',
            is_safe_signature: true
          },
          message
        },
        verifier
      )
    ).resolves.toMatchObject({
      valid: true,
      signer_address: wallet.address.toLowerCase()
    });
    expect(verifier.isValidSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 1,
        contractAddress: wallet.address.toLowerCase(),
        signature: '0xsafe'
      })
    );
  });

  it('rejects EIP-1271 verification when signer has no contract code on the selected chain', async () => {
    const verifier: Eip1271SignatureVerifier = {
      hasContractCode: jest.fn().mockResolvedValue(false),
      isValidSignature: jest.fn()
    };

    await expect(
      verifyProfileCmsPublishSignature(
        {
          request: {
            ...requestBase,
            signature: '0xsafe',
            is_safe_signature: true
          },
          message
        },
        verifier
      )
    ).resolves.toMatchObject({
      valid: false,
      reason: 'eip1271_signer_has_no_contract_code'
    });
    expect(verifier.hasContractCode).toHaveBeenCalledWith({
      chainId: 1,
      contractAddress: wallet.address.toLowerCase()
    });
    expect(verifier.isValidSignature).not.toHaveBeenCalled();
  });
});
