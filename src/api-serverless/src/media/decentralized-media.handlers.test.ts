import { handleResolveDecentralizedMedia } from './decentralized-media.handlers';

describe('handleResolveDecentralizedMedia', () => {
  const cid = 'QmYwAPJzv5CZsnAzt8auVTL6rQJ8K8Y1YwecqHHU1Q6iCk';

  it('resolves a batch of native and gateway inputs', async () => {
    await expect(
      handleResolveDecentralizedMedia({
        body: {
          inputs: [`ipfs://${cid}/image.png`, `https://ipfs.io/ipfs/${cid}`],
          include_external_fallbacks: true
        }
      } as any)
    ).resolves.toMatchObject({
      items: [
        {
          input: `ipfs://${cid}/image.png`,
          recognized: true,
          protocol: 'ipfs',
          native_uri: `ipfs://${cid}/image.png`,
          resolver_url: `https://media.6529.io/ipfs/${cid}/image.png`,
          external_fallback_urls: expect.arrayContaining([
            `https://ipfs.io/ipfs/${cid}/image.png`,
            `https://ipfs.6529.io/ipfs/${cid}/image.png`
          ]),
          warnings: []
        },
        {
          input: `https://ipfs.io/ipfs/${cid}`,
          recognized: true,
          native_uri: `ipfs://${cid}`,
          resolver_url: `https://media.6529.io/ipfs/${cid}`
        }
      ]
    });
  });

  it('returns item-level failures for invalid and unrecognized inputs', async () => {
    await expect(
      handleResolveDecentralizedMedia({
        body: {
          inputs: ['https://%zz', 'https://example.com/image.png', '', '   '],
          include_external_fallbacks: true
        }
      } as any)
    ).resolves.toEqual({
      items: [
        {
          input: 'https://%zz',
          recognized: false,
          external_fallback_urls: [],
          warnings: ['invalid_url']
        },
        {
          input: 'https://example.com/image.png',
          recognized: false,
          external_fallback_urls: [],
          warnings: []
        },
        {
          input: '',
          recognized: false,
          external_fallback_urls: [],
          warnings: ['invalid_url']
        },
        {
          input: '   ',
          recognized: false,
          external_fallback_urls: [],
          warnings: ['invalid_url']
        }
      ]
    });
  });

  it('can omit external fallbacks', async () => {
    await expect(
      handleResolveDecentralizedMedia({
        body: {
          inputs: [`ipfs://${cid}`],
          include_external_fallbacks: false
        }
      } as any)
    ).resolves.toMatchObject({
      items: [
        {
          recognized: true,
          resolver_url: `https://media.6529.io/ipfs/${cid}`,
          external_fallback_urls: []
        }
      ]
    });
  });
});
