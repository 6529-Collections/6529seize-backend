import { ethers } from 'ethers';
import { validateNextgenBurn } from '@/api/nextgen/validation';
import {
  buildStructuredWalletSignatureMessage,
  clearStructuredWalletSignatureReplayCacheForTests,
  hashStructuredWalletSignaturePayload
} from '@/api/wallet-signatures/structured-wallet-signatures';

const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);

const burnPayload = {
  uuid: '4f0b8f0e-2d7d-4b8e-9f3c-1a2b3c4d5e6f',
  collection_id: 1,
  burn_collection: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
  burn_collection_id: 2,
  min_token_index: 0,
  max_token_index: 10,
  burn_address: '0x000000000000000000000000000000000000dead',
  status: true
};

async function structuredBody(
  payload: typeof burnPayload,
  nonce: string,
  signedPayload: unknown = payload
) {
  const message = buildStructuredWalletSignatureMessage({
    kind: 'action',
    domain: 'example.com',
    wallet: wallet.address,
    nonce,
    action: 'nextgen_admin',
    payloadHash: hashStructuredWalletSignaturePayload(signedPayload),
    purpose: 'Sign this message to perform a 6529 NextGen admin action.'
  });
  return {
    ...payload,
    wallet: wallet.address,
    signature: await wallet.signMessage(message),
    signature_message: message
  };
}

async function validate(body: unknown) {
  const req: any = { body };
  const next = jest.fn();
  await validateNextgenBurn(req, {}, next);
  expect(next).toHaveBeenCalled();
  return req.validatedBody;
}

describe('validateNextgenBurn signatures', () => {
  beforeEach(() => {
    clearStructuredWalletSignatureReplayCacheForTests();
    process.env.ETHEREUM_RPC_URL = 'https://rpc.example.test';
    jest.spyOn(ethers, 'Contract', 'get').mockReturnValue(
      jest.fn().mockImplementation(() => ({
        retrieveGlobalAdmin: jest.fn().mockResolvedValue(true),
        retrieveFunctionAdmin: jest.fn().mockResolvedValue(false),
        retrieveCollectionAdmin: jest.fn().mockResolvedValue(false)
      })) as unknown as typeof ethers.Contract
    );
  });

  afterEach(() => {
    delete process.env.ETHEREUM_RPC_URL;
    delete process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED;
    jest.restoreAllMocks();
  });

  it('accepts a structured signature over the request payload', async () => {
    const result = await validate(
      await structuredBody(burnPayload, 'nextgen-nonce-1')
    );
    expect(result).toEqual(
      expect.objectContaining({ valid: true, collection_id: 1 })
    );
  });

  it('requires the structured signature even when the global flag is off', async () => {
    delete process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED;
    const result = await validate({
      ...burnPayload,
      wallet: wallet.address,
      signature: await wallet.signMessage(burnPayload.uuid)
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('signature_message');
  });

  it('accepts each structured signature only once', async () => {
    const body = await structuredBody(burnPayload, 'nextgen-nonce-2');
    expect((await validate(body)).valid).toBe(true);
    expect(await validate(body)).toEqual({
      valid: false,
      error: 'Invalid signature'
    });
  });

  it('binds the signature to the request payload', async () => {
    const body = await structuredBody(
      { ...burnPayload, max_token_index: 9999 },
      'nextgen-nonce-3',
      burnPayload
    );
    expect(await validate(body)).toEqual({
      valid: false,
      error: 'Invalid signature'
    });
  });
});
