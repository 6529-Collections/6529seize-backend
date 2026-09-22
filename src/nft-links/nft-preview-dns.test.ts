import { Resolver } from 'node:dns/promises';
import { resolvePreviewHost } from './nft-preview-dns';
import { nftLinkMediaPreviewService as service } from './nft-link-media-preview.service';
import { env } from '@/env';

afterEach(() => jest.restoreAllMocks());

it('cancels both outstanding DNS queries when the download deadline expires', async () => {
  const pending: ((error: Error) => void)[] = [];
  const lookup = jest.fn(
    () => new Promise<string[]>((_resolve, reject) => pending.push(reject))
  );
  jest
    .spyOn(Resolver.prototype, 'resolve4')
    .mockImplementation(lookup as never);
  jest
    .spyOn(Resolver.prototype, 'resolve6')
    .mockImplementation(lookup as never);
  const cancel = jest
    .spyOn(Resolver.prototype, 'cancel')
    .mockImplementation(() => {
      pending
        .splice(0)
        .forEach((reject) => reject(new Error('query cancelled')));
    });
  const fetch = jest.spyOn(service as never, 'fetchWithTimeout');
  jest
    .spyOn(env, 'getIntOrNull')
    .mockImplementation((key) =>
      key === 'NFT_LINK_MEDIA_PREVIEW_DOWNLOAD_TIMEOUT_MS' ? 20 : null
    );
  await expect(
    service['downloadRemoteImage']('https://example.com/video')
  ).rejects.toThrow('download deadline exceeded');
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalled();
  expect(pending).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

it('returns both address families and removes the abort listener after success', async () => {
  jest
    .spyOn(Resolver.prototype, 'resolve4')
    .mockResolvedValue(['8.8.8.8'] as never);
  jest
    .spyOn(Resolver.prototype, 'resolve6')
    .mockResolvedValue(['2001:4860:4860::8888'] as never);
  const controller = new AbortController();
  const remove = jest.spyOn(controller.signal, 'removeEventListener');
  await expect(
    resolvePreviewHost('example.com', controller.signal)
  ).resolves.toEqual([
    { address: '8.8.8.8', family: 4 },
    { address: '2001:4860:4860::8888', family: 6 }
  ]);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});

it('accepts IPv4-only DNS but fails closed on an incomplete family lookup', async () => {
  jest
    .spyOn(Resolver.prototype, 'resolve4')
    .mockResolvedValue(['8.8.8.8'] as never);
  const ipv6 = jest
    .spyOn(Resolver.prototype, 'resolve6')
    .mockRejectedValue({ code: 'ENODATA' });
  await expect(resolvePreviewHost('example.com')).resolves.toEqual([
    { address: '8.8.8.8', family: 4 }
  ]);
  ipv6.mockRejectedValue({ code: 'SERVFAIL' });
  await expect(resolvePreviewHost('example.com')).rejects.toEqual({
    code: 'SERVFAIL'
  });
});

it('still blocks mixed public/private DNS answers and literal local addresses', async () => {
  jest
    .spyOn(Resolver.prototype, 'resolve4')
    .mockResolvedValue(['8.8.8.8'] as never);
  jest
    .spyOn(Resolver.prototype, 'resolve6')
    .mockResolvedValue(['::1'] as never);
  for (const url of [
    'https://example.com/x',
    'http://127.0.0.1/x',
    'http://[::1]/x'
  ]) {
    await expect(service['resolveSafeRemoteUrl'](url)).rejects.toThrow(
      'private/local'
    );
  }
});
