import { competitionChainIdPaths } from './competition-chain-id.middleware';

const CHAIN_ID = `0x${'3c'.repeat(32)}`;
const UUID = '9a404fbe-be9b-5cbb-a70b-872173014744';

describe('competitionChainIdPaths', () => {
  const repository = {
    findCompetitionIdOfChainId: jest.fn(async () => UUID)
  };
  const rewrite = async (url: string) => {
    const req = { url } as any;
    const next = jest.fn();
    await competitionChainIdPaths(repository)(req, {} as any, next);
    expect(next).toHaveBeenCalledWith();
    return req.url;
  };

  beforeEach(() => repository.findCompetitionIdOfChainId.mockClear());

  it("rewrites a competition path's chain id to 6529.io's id, keeping the rest", async () => {
    expect(await rewrite(`/v3/waves/w-1/competitions/${CHAIN_ID}`)).toBe(
      `/v3/waves/w-1/competitions/${UUID}`
    );
    expect(
      await rewrite(
        `/v3/waves/${CHAIN_ID}/competitions/${CHAIN_ID.toUpperCase().replace('0X', '0x')}/entries?limit=5`
      )
    ).toBe(`/v3/waves/${CHAIN_ID}/competitions/${UUID}/entries?limit=5`);
    expect(repository.findCompetitionIdOfChainId).toHaveBeenCalledTimes(2);
  });

  it('leaves other paths, and UUID ids, as they are', async () => {
    for (const url of [
      `/v3/waves/w-1/competitions/${UUID}`,
      `/v3/waves/w-1/competitions`,
      `/v3/waves/w-1/competitions/${CHAIN_ID}0`,
      `/v3/drops/${CHAIN_ID}`
    ]) {
      expect(await rewrite(url)).toBe(url);
    }
    expect(repository.findCompetitionIdOfChainId).not.toHaveBeenCalled();
  });

  it('passes a lookup failure on', async () => {
    const error = new Error('down');
    const next = jest.fn();
    await competitionChainIdPaths({
      findCompetitionIdOfChainId: jest.fn().mockRejectedValue(error)
    })({ url: `/v3/waves/w/competitions/${CHAIN_ID}` } as any, {} as any, next);
    expect(next).toHaveBeenCalledWith(error);
  });
});
