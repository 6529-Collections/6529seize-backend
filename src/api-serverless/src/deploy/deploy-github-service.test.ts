import fetch from 'node-fetch';
import { GitHubDeployService } from '@/api/deploy/deploy.github.service';

jest.mock('node-fetch', () => jest.fn());

type MockResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: {
    get: jest.Mock<string | null, [string]>;
  };
  json: jest.Mock<Promise<unknown>, []>;
};

function createResponse(jsonPayload: unknown): MockResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: jest.fn().mockReturnValue(null)
    },
    json: jest.fn().mockResolvedValue(jsonPayload)
  };
}

describe('GitHubDeployService.listRefs', () => {
  const fetchMock = jest.mocked(fetch);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('uses matching refs lookup for typed queries', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createResponse([{ ref: 'refs/heads/main' }]) as never
      )
      .mockResolvedValueOnce(createResponse([]) as never);

    const service = new GitHubDeployService();
    const refs = await service.listRefs('token', 'backend', 'main', 20);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      '/repos/6529-Collections/6529seize-backend/git/matching-refs/heads/main'
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      '/repos/6529-Collections/6529seize-backend/git/matching-refs/tags/main'
    );
    expect(refs).toEqual([{ name: 'main', type: 'branch' }]);
  });

  it('falls back to branch and tag listing when query is empty', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse([{ name: 'main' }]) as never)
      .mockResolvedValueOnce(createResponse([{ name: 'v1.0.0' }]) as never);

    const service = new GitHubDeployService();
    const refs = await service.listRefs('token', 'backend', '', 20);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/branches?per_page=100');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/tags?per_page=100');
    expect(refs).toEqual([
      { name: 'main', type: 'branch' },
      { name: 'v1.0.0', type: 'tag' }
    ]);
  });
});
