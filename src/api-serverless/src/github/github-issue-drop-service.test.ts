import { AiPrompter } from '@/abusiveness/ai-prompter';
import { Wallet, verifyMessage } from 'ethers';
import fetch from 'node-fetch';
import { GitHubIssueDropService } from './github-issue-drop.service';

jest.mock('node-fetch', () => jest.fn());

const PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f094538423616ff67a53e886e68660d054d60f1a';
const CLIENT_ADDRESS = new Wallet(PRIVATE_KEY).address;
const SIGNABLE_MESSAGE = [
  '6529 Authentication',
  'Version: 2',
  'Audience: api.test',
  'Domain: native',
  'Session Type: native',
  `Wallet: ${CLIENT_ADDRESS}`,
  'Chain ID: 1',
  'Issued At: 2026-01-01T00:00:00.000Z',
  'Expiration Time: 2026-01-01T00:05:00.000Z',
  'Nonce: github-auth-nonce',
  'Action: login',
  'Purpose: Sign this message to authenticate with 6529.'
].join('\n');
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
  });
});
