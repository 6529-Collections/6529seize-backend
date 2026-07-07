import {
  fetchNextGenMetadata,
  NextGenMetadataFetchError
} from './nextgen-metadata';

function metadataResponse({
  body = '{"name":"Token"}',
  status = 200,
  contentType = 'application/json'
}: {
  body?: string;
  contentType?: string;
  status?: number;
}) {
  return {
    ok: status < 400,
    status,
    text: jest.fn().mockResolvedValue(body),
    headers: {
      get: jest.fn((header: string) =>
        header.toLowerCase() === 'content-type' ? contentType : null
      )
    }
  };
}

describe('fetchNextGenMetadata', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetAllMocks();
  });

  it('retries retryable HTTP failures before returning metadata', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(metadataResponse({ status: 500 }))
      .mockResolvedValueOnce(metadataResponse({}));
    global.fetch = fetchMock as any;

    await expect(
      fetchNextGenMetadata('https://metadata.example/token/1')
    ).resolves.toEqual({ name: 'Token' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry invalid metadata payloads', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      metadataResponse({
        body: '<html>bad</html>',
        contentType: 'text/html'
      })
    );
    global.fetch = fetchMock as any;

    await expect(
      fetchNextGenMetadata('https://metadata.example/token/1')
    ).rejects.toMatchObject({
      retryable: false
    } as Partial<NextGenMetadataFetchError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
