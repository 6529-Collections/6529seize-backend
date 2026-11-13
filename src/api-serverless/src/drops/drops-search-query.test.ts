import { prepLatestDropsSearchQuery } from './drops.routes';

jest.mock('passport', () => ({
  authenticate: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next()
  )
}));

function requestWithPublicOnly(public_only: unknown) {
  return {
    query: { limit: 10, public_only }
  } as Parameters<typeof prepLatestDropsSearchQuery>[0];
}

describe('latest drops public-only query', () => {
  it.each([
    { input: undefined, expected: false },
    { input: 'false', expected: false },
    { input: 'true', expected: true }
  ])('parses $input as $expected', async ({ input, expected }) => {
    await expect(
      prepLatestDropsSearchQuery(requestWithPublicOnly(input))
    ).resolves.toEqual(expect.objectContaining({ public_only: expected }));
  });

  it.each([
    { input: 'invalid' },
    { input: '1' },
    { input: ['true', 'false'] },
    { input: { value: 'true' } }
  ])('rejects an invalid public-only value $input', async ({ input }) => {
    await expect(
      prepLatestDropsSearchQuery(requestWithPublicOnly(input))
    ).rejects.toThrow();
  });
});
