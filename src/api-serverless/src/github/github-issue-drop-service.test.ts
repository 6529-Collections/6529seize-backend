import { AiPrompter } from '@/abusiveness/ai-prompter';
import { toApiDeviceGrant } from '@/api/device-signing/device-signing.mappers';
import { AuthenticationContext } from '@/auth-context';
import { hasLoneSurrogate } from '@/strings';
import { signingBot } from '@/tests/fixtures/bot-device-signing.fixture';
import { Wallet, verifyMessage } from 'ethers';
import fetch from 'node-fetch';
import {
  GitHubDropRefusedError,
  GitHubIssueDropService
} from './github-issue-drop.service';

jest.mock('node-fetch', () => jest.fn());

const PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f094538423616ff67a53e886e68660d054d60f1a';
const CLIENT_ADDRESS = new Wallet(PRIVATE_KEY).address;
const ISSUED_AT = new Date(Date.now() - 1_000).toISOString();
const EXPIRATION_TIME = new Date(Date.now() + 5 * 60 * 1_000).toISOString();
const SIGNABLE_MESSAGE = buildSignableMessage();
const PR_URL = 'https://github.com/6529-Collections/test/pull/456';
const ISSUE_URL = 'https://github.com/6529-Collections/test/issues/123';

type MockResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: jest.Mock<Promise<unknown>, []>;
  text: jest.Mock<Promise<string>, []>;
};

type CreateDropRequestBody = {
  wave_id: string;
  signer_address: string;
  parts: Array<{
    content: string;
  }>;
};

type LoginRequestBody = {
  client_address: string;
  client_signature: string;
  server_signature: string;
  is_safe_wallet: boolean;
};

function buildSignableMessage({
  action = 'login',
  expirationTime = EXPIRATION_TIME
}: {
  action?: string;
  expirationTime?: string;
} = {}): string {
  return [
    '6529 Authentication',
    'Version: 2',
    'Audience: api.test',
    'Domain: native',
    'Session Type: native',
    `Wallet: ${CLIENT_ADDRESS}`,
    'Chain ID: 1',
    `Issued At: ${ISSUED_AT}`,
    `Expiration Time: ${expirationTime}`,
    'Nonce: github-auth-nonce',
    `Action: ${action}`,
    'Purpose: Sign this message to authenticate with 6529.'
  ].join('\n');
}

function createJsonResponse(jsonPayload: unknown): MockResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: jest.fn().mockResolvedValue(jsonPayload),
    text: jest.fn().mockResolvedValue('')
  };
}

function getCreateDropBody(): CreateDropRequestBody {
  const createDropCall = jest.mocked(fetch).mock.calls[2];
  if (!createDropCall) {
    throw new Error('Expected create drop request');
  }

  const request = createDropCall[1] as { body: string };
  return JSON.parse(request.body) as CreateDropRequestBody;
}

function getFetchUrl(callIndex: number): URL {
  const call = jest.mocked(fetch).mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected fetch call ${callIndex}`);
  }

  return new URL(String(call[0]));
}

function getLoginBody(): LoginRequestBody {
  const loginCall = jest.mocked(fetch).mock.calls[1];
  if (!loginCall) {
    throw new Error('Expected login request');
  }

  const request = loginCall[1] as { body: string };
  return JSON.parse(request.body) as LoginRequestBody;
}

function mockSuccessfulAuth(fetchMock: jest.MockedFunction<typeof fetch>) {
  fetchMock
    .mockResolvedValueOnce(
      createJsonResponse({
        signable_message: SIGNABLE_MESSAGE,
        server_signature: 'server-signature'
      }) as never
    )
    .mockResolvedValueOnce(
      createJsonResponse({
        token: 'auth-token'
      }) as never
    )
    .mockResolvedValueOnce(createJsonResponse({}) as never);
}

describe('GitHubIssueDropService', () => {
  const fetchMock = jest.mocked(fetch);
  let aiPrompter: jest.Mocked<AiPrompter>;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    jest.resetAllMocks();
    originalEnv = {
      API_BASE_URL: process.env.API_BASE_URL,
      GH_WEBHOOK_WALLET_PRIVATE_KEY: process.env.GH_WEBHOOK_WALLET_PRIVATE_KEY,
      GH_WEBHOOK_WAVE_ID: process.env.GH_WEBHOOK_WAVE_ID
    };
    process.env.GH_WEBHOOK_WALLET_PRIVATE_KEY = PRIVATE_KEY;
    process.env.GH_WEBHOOK_WAVE_ID = 'wave-1';
    process.env.API_BASE_URL = 'https://api.test';
    aiPrompter = {
      promptAndGetReply: jest.fn()
    };
    mockSuccessfulAuth(fetchMock);
  });

  afterEach(() => {
    restoreEnv('GH_WEBHOOK_WALLET_PRIVATE_KEY');
    restoreEnv('GH_WEBHOOK_WAVE_ID');
    restoreEnv('API_BASE_URL');
  });

  function restoreEnv(name: string) {
    const value = originalEnv[name];
    if (value === undefined) {
      delete process.env[name];
      return;
    }

    process.env[name] = value;
  }

  it('posts merged pull requests with the PR link and AI summary', async () => {
    aiPrompter.promptAndGetReply.mockResolvedValue(
      'Members can now read clearer release notes about user-facing changes.'
    );

    await new GitHubIssueDropService(aiPrompter).postGhIssueDrop(
      PR_URL,
      'pull request',
      {
        action: 'merged',
        title: 'Improve release notes',
        body: 'Adds release notes that explain user-facing changes.'
      }
    );

    expect(aiPrompter.promptAndGetReply).toHaveBeenCalledWith(
      expect.stringContaining('Improve release notes')
    );
    expect(aiPrompter.promptAndGetReply).toHaveBeenCalledWith(
      expect.stringContaining('Adds release notes')
    );
    expect(getCreateDropBody()).toMatchObject({
      wave_id: 'wave-1',
      signer_address: CLIENT_ADDRESS,
      parts: [
        {
          content: `${PR_URL}\n\nMembers can now read clearer release notes about user-facing changes.`
        }
      ]
    });
  });

  it('uses session-v2 structured auth before posting the drop', async () => {
    await new GitHubIssueDropService(aiPrompter).postGhIssueDrop(
      ISSUE_URL,
      'issue',
      {
        action: 'reopened'
      }
    );

    const sessionNonceUrl = getFetchUrl(0);
    expect(sessionNonceUrl.pathname).toBe('/api/auth/session-nonce');
    expect(sessionNonceUrl.searchParams.get('signer_address')).toBe(
      CLIENT_ADDRESS
    );
    expect(sessionNonceUrl.searchParams.get('client_type')).toBe('native');
    expect(sessionNonceUrl.searchParams.get('short_nonce')).toBeNull();

    const loginUrl = getFetchUrl(1);
    expect(loginUrl.pathname).toBe('/api/auth/login');
    expect(loginUrl.searchParams.get('signer_address')).toBe(CLIENT_ADDRESS);

    const loginBody = getLoginBody();
    expect(loginBody).toMatchObject({
      client_address: CLIENT_ADDRESS,
      server_signature: 'server-signature',
      is_safe_wallet: false
    });
    expect(
      verifyMessage(SIGNABLE_MESSAGE, loginBody.client_signature).toLowerCase()
    ).toBe(CLIENT_ADDRESS.toLowerCase());

    const createDropUrl = getFetchUrl(2);
    expect(createDropUrl.pathname).toBe('/api/drops');
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      headers: expect.objectContaining({
        authorization: 'Bearer auth-token'
      })
    });
    expect(getCreateDropBody()).toMatchObject({
      wave_id: 'wave-1',
      signer_address: CLIENT_ADDRESS,
      parts: [
        {
          content: ISSUE_URL
        }
      ]
    });
  });

  it('preserves path prefixes from API_BASE_URL when building API requests', async () => {
    process.env.API_BASE_URL = 'https://api.test/base/';

    await new GitHubIssueDropService(aiPrompter).postGhIssueDrop(
      ISSUE_URL,
      'issue',
      {
        action: 'opened'
      }
    );

    expect(getFetchUrl(0).pathname).toBe('/base/api/auth/session-nonce');
    expect(getFetchUrl(1).pathname).toBe('/base/api/auth/login');
    expect(getFetchUrl(2).pathname).toBe('/base/api/drops');
  });

  it('rejects malformed session nonce responses before signing', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        server_signature: 'server-signature'
      }) as never
    );

    await expect(
      new GitHubIssueDropService(aiPrompter).postGhIssueDrop(
        ISSUE_URL,
        'issue',
        {
          action: 'opened'
        }
      )
    ).rejects.toThrow('Invalid session nonce response');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects session nonce messages for unexpected auth context', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        signable_message: buildSignableMessage({ action: 'link' }),
        server_signature: 'server-signature'
      }) as never
    );

    await expect(
      new GitHubIssueDropService(aiPrompter).postGhIssueDrop(
        ISSUE_URL,
        'issue',
        {
          action: 'opened'
        }
      )
    ).rejects.toThrow('Invalid session nonce response');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed login responses before posting the drop', async () => {
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          signable_message: SIGNABLE_MESSAGE,
          server_signature: 'server-signature'
        }) as never
      )
      .mockResolvedValueOnce(
        createJsonResponse({ refresh_token: 'ignored' }) as never
      );

    await expect(
      new GitHubIssueDropService(aiPrompter).postGhIssueDrop(
        ISSUE_URL,
        'issue',
        {
          action: 'opened'
        }
      )
    ).rejects.toThrow('Invalid login response');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('posts non-merged GitHub events without asking AI for a summary', async () => {
    await new GitHubIssueDropService(aiPrompter).postGhIssueDrop(
      ISSUE_URL,
      'issue',
      {
        action: 'opened'
      }
    );

    expect(aiPrompter.promptAndGetReply).not.toHaveBeenCalled();
    expect(getCreateDropBody()).toMatchObject({
      wave_id: 'wave-1',
      signer_address: CLIENT_ADDRESS,
      parts: [
        {
          content: ISSUE_URL
        }
      ]
    });
    expect(getCreateDropBody()).not.toHaveProperty('device_signature');
  });

  it('cuts a long summary without splitting an emoji', async () => {
    aiPrompter.promptAndGetReply.mockResolvedValue(
      `${'a'.repeat(996)}😀${'b'.repeat(10)}`
    );

    await new GitHubIssueDropService(aiPrompter).postGhIssueDrop(
      PR_URL,
      'pull request',
      { action: 'merged', title: 'Emoji' }
    );

    const content = getCreateDropBody().parts[0].content;
    expect(hasLoneSurrogate(content)).toBe(false);
    expect(content.endsWith(`${'a'.repeat(996)}...`)).toBe(true);
  });

  it('never repeats a malformed wallet key in its error', async () => {
    const malformed = `${PRIVATE_KEY.slice(0, -1)}z`;
    process.env.GH_WEBHOOK_WALLET_PRIVATE_KEY = malformed;

    const error = await new GitHubIssueDropService(aiPrompter)
      .postGhIssueDrop(ISSUE_URL, 'issue', { action: 'opened' })
      .then(
        () => new Error('expected a refusal'),
        (e: Error) => e
      );

    expect(error.message).toBe(
      'GH_WEBHOOK_WALLET_PRIVATE_KEY is not a private key'
    );
    expect(String(error)).not.toContain(malformed.slice(4, 30));
  });

  it('fails the delivery when the API requires a device signature it lacks', async () => {
    routeFetch({
      grants: () => [],
      posts: [
        failure(
          403,
          '{"error":"Posts in waves are now signed by your device.","code":"DEVICE_SIGNATURE_REQUIRED"}'
        )
      ]
    });

    await expect(
      new GitHubIssueDropService(aiPrompter).postGhIssueDrop(
        ISSUE_URL,
        'issue',
        { action: 'opened' }
      )
    ).rejects.toBeInstanceOf(GitHubDropRefusedError);
    expect(postedBodies()).toHaveLength(1);
  });

  describe('with a device key for the bot', () => {
    const signingGitHubBot = () =>
      signingBot({
        profileId: 'github-bot',
        otherWallets: { [CLIENT_ADDRESS.toLowerCase()]: 'github-bot' }
      });

    it('signs the drop when the API holds the grant, and the API accepts it', async () => {
      const { signer, store, writes } = await signingGitHubBot();
      routeFetch({
        grants: () => Array.from(store.grants.values()).map(toApiDeviceGrant)
      });

      await new GitHubIssueDropService(aiPrompter, signer).postGhIssueDrop(
        ISSUE_URL,
        'issue',
        { action: 'opened' }
      );

      const [{ device_signature: envelope, ...body }] = postedBodies();
      expect(envelope).toMatchObject({ grant_id: expect.any(String) });
      // The API's own check of POST /drops, over the body as sent.
      await expect(
        writes.createDrop(
          { envelope, waveId: 'wave-1', replyToDropId: null, body },
          async () => ({ id: 'github-drop' }),
          {
            authenticationContext:
              AuthenticationContext.fromProfileId('github-bot')
          }
        )
      ).resolves.toEqual({ id: 'github-drop' });
      expect(store.events[0]).toMatchObject({
        wave_id: 'wave-1',
        drop_id: 'github-drop',
        profile_id: 'github-bot'
      });
    });

    it.each([
      ['holds no grant (another deployment)', () => []],
      [
        'holds the grant revoked',
        (grants: Record<string, unknown>[]) =>
          grants.map((grant) => ({ ...grant, revoked_at: 1 }))
      ]
    ])('posts unsigned when the API it posts to %s', async (_name, adjust) => {
      const { signer, store } = await signingGitHubBot();
      routeFetch({
        grants: () =>
          adjust(
            Array.from(store.grants.values()).map(
              toApiDeviceGrant
            ) as unknown as Record<string, unknown>[]
          )
      });

      await new GitHubIssueDropService(aiPrompter, signer).postGhIssueDrop(
        ISSUE_URL,
        'issue',
        { action: 'opened' }
      );

      const bodies = postedBodies();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toHaveProperty('device_signature');
    });

    it.each([
      ['answers 502', () => failure(502, 'Bad Gateway')],
      ['answers something other than a list', () => ({ grants: [] })],
      [
        'cannot be reached',
        () => {
          throw new Error('socket hang up');
        }
      ]
    ])(
      'signs anyway when the grant list %s, so a passing fault never posts unsigned',
      async (_name, answer) => {
        const { signer } = await signingGitHubBot();
        routeFetch({ grants: answer });

        await new GitHubIssueDropService(aiPrompter, signer).postGhIssueDrop(
          ISSUE_URL,
          'issue',
          { action: 'opened' }
        );

        const bodies = postedBodies();
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toHaveProperty('device_signature');
      }
    );

    it('falls back to unsigned when it signed blind and the API lacks the grant', async () => {
      const { signer } = await signingGitHubBot();
      routeFetch({
        grants: () => failure(502, 'Bad Gateway'),
        posts: [
          failure(
            400,
            '{"error":"Invalid device signature: unknown grant","code":"INVALID_DEVICE_SIGNATURE"}'
          )
        ]
      });

      await new GitHubIssueDropService(aiPrompter, signer).postGhIssueDrop(
        ISSUE_URL,
        'issue',
        { action: 'opened' }
      );

      const bodies = postedBodies();
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toHaveProperty('device_signature');
      expect(bodies[1]).not.toHaveProperty('device_signature');
    });

    it('posts unsigned when the API refuses the device signature', async () => {
      const { signer, store } = await signingGitHubBot();
      routeFetch({
        grants: () => Array.from(store.grants.values()).map(toApiDeviceGrant),
        posts: [
          failure(
            400,
            '{"error":"Invalid device signature: grant was revoked","code":"INVALID_DEVICE_SIGNATURE"}'
          )
        ]
      });

      await new GitHubIssueDropService(aiPrompter, signer).postGhIssueDrop(
        ISSUE_URL,
        'issue',
        { action: 'opened' }
      );

      const bodies = postedBodies();
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toHaveProperty('device_signature');
      expect(bodies[1]).not.toHaveProperty('device_signature');
      expect(bodies[1].parts[0].content).toBe(ISSUE_URL);
    });

    it('fails the delivery when the unsigned retry is refused too', async () => {
      const { signer, store } = await signingGitHubBot();
      routeFetch({
        grants: () => Array.from(store.grants.values()).map(toApiDeviceGrant),
        posts: [
          failure(
            400,
            '{"error":"Invalid device signature: grant expired","code":"INVALID_DEVICE_SIGNATURE"}'
          ),
          failure(
            403,
            '{"error":"Posts in waves are now signed by your device.","code":"DEVICE_SIGNATURE_REQUIRED"}'
          )
        ]
      });

      await expect(
        new GitHubIssueDropService(aiPrompter, signer).postGhIssueDrop(
          ISSUE_URL,
          'issue',
          { action: 'opened' }
        )
      ).rejects.toBeInstanceOf(GitHubDropRefusedError);
      expect(postedBodies()).toHaveLength(2);
    });
  });
});

function failure(status: number, text: string): MockResponse {
  return {
    ok: false,
    status,
    statusText: 'Refused',
    json: jest.fn().mockRejectedValue(new Error('not JSON')),
    text: jest.fn().mockResolvedValue(text)
  };
}

/** Answers each API path; POST /drops takes `posts` in turn, then 200. */
function routeFetch({
  grants,
  posts = []
}: {
  readonly grants: () => unknown;
  readonly posts?: MockResponse[];
}) {
  const fetchMock = jest.mocked(fetch);
  fetchMock.mockReset();
  fetchMock.mockImplementation((async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/auth/session-nonce')) {
      return createJsonResponse({
        signable_message: SIGNABLE_MESSAGE,
        server_signature: 'server-signature'
      });
    }
    if (path.endsWith('/auth/login')) {
      return createJsonResponse({ token: 'auth-token' });
    }
    if (path.endsWith('/device-grants')) {
      const answer = grants();
      return isMockResponse(answer) ? answer : createJsonResponse(answer);
    }
    if (path.endsWith('/drops')) {
      return posts.shift() ?? createJsonResponse({});
    }
    throw new Error(`Unexpected request to ${path}`);
  }) as never);
}

function isMockResponse(value: unknown): value is MockResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    'text' in value
  );
}

/** The bodies of every POST /drops, in order. */
function postedBodies(): Record<string, any>[] {
  return jest
    .mocked(fetch)
    .mock.calls.filter(([url]) =>
      new URL(String(url)).pathname.endsWith('/drops')
    )
    .map(([, init]) => JSON.parse((init as { body: string }).body));
}
