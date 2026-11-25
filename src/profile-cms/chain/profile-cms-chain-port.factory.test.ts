import { createProfileCmsChainPort } from '@/profile-cms/chain/profile-cms-chain-port.factory';

describe('createProfileCmsChainPort', () => {
  const configured = process.env.CHAIN_GATEWAY_URL;

  beforeEach(() => {
    process.env.CHAIN_GATEWAY_URL = 'https://gateway.example.test/';
  });

  afterEach(() => {
    if (configured === undefined) {
      delete process.env.CHAIN_GATEWAY_URL;
    } else {
      process.env.CHAIN_GATEWAY_URL = configured;
    }
  });

  it('refuses until the identity mirror is wired in', () => {
    expect(() => createProfileCmsChainPort()).toThrow(
      'No chain gateway adapter yet'
    );
  });

  it('takes the configured gateway, with or without a trailing slash', () => {
    expect(() =>
      createProfileCmsChainPort('https://gateway.example.test')
    ).toThrow('No chain gateway adapter yet');
  });

  it('refuses a gateway other than CHAIN_GATEWAY_URL', () => {
    expect(() =>
      createProfileCmsChainPort('https://other-gateway.example.test')
    ).toThrow(
      'Profile sites read the chain at CHAIN_GATEWAY_URL; set it to https://other-gateway.example.test to read that gateway'
    );
  });
});
