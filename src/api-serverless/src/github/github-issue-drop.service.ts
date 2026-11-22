import { AiPrompter } from '@/abusiveness/ai-prompter';
import { openAiPrompter } from '@/abusiveness/open-ai.prompter';
import { Wallet } from 'ethers';
import fetch from 'node-fetch';
import { env } from '../../../env';
import { Logger } from '../../../logging';
import { sliceWholeCodePoints } from '../../../strings';
import {
  BotDeviceSigner,
  botDeviceSigner
} from '../device-signing/bot-device-signer';
import { DeviceEventKind } from '../device-signing/device-event';
import type {
  DeviceSignatureEnvelope,
  SignedWriteTarget
} from '../device-signing/device-signed-writes.service';
import { parseStructuredWalletSignatureMessage } from '../wallet-signatures/structured-wallet-signatures';
import { GitHubWebhookAction } from './github-webhook-event';

const INVALID_DEVICE_SIGNATURE_CODE = 'INVALID_DEVICE_SIGNATURE';
const DEVICE_SIGNATURE_REQUIRED_CODE = 'DEVICE_SIGNATURE_REQUIRED';

/**
 * The API refused the drop because it needs a device signature the bot
 * could not give. The webhook delivery should fail, so it can be delivered
 * again once the bot's key is fixed, instead of the drop being lost.
 */
export class GitHubDropRefusedError extends Error {
  constructor(reason: string) {
    super(`The API refused the GitHub drop: ${reason}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'GitHubDropRefusedError';
  }
}

type GitHubDropTargetKind = 'issue' | 'pull request';
type PostGitHubDropOptions = {
  readonly action?: GitHubWebhookAction;
  readonly title?: string;
  readonly body?: string;
};
type SessionNonceResponse = {
  readonly signable_message: string;
  readonly server_signature: string;
};
type LoginResponse = {
  readonly token: string;
};

const PULL_REQUEST_SUMMARY_MAX_LENGTH = 1000;
const PULL_REQUEST_PROMPT_BODY_MAX_LENGTH = 12000;
// Must match the session-v2 client type expected by structured native auth.
const GITHUB_WEBHOOK_AUTH_CLIENT_TYPE = 'native';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getNonEmptyString(
  value: Record<string, unknown>,
  field: string
): string | null {
  const fieldValue = value[field];
  return typeof fieldValue === 'string' && fieldValue.trim().length > 0
    ? fieldValue
    : null;
}

function removeLeadingSlashes(value: string): string {
  let startIndex = 0;
  while (startIndex < value.length && value[startIndex] === '/') {
    startIndex++;
  }
  return value.slice(startIndex);
}

function removeTrailingSlashes(value: string): string {
  let endIndex = value.length;
  while (endIndex > 0 && value[endIndex - 1] === '/') {
    endIndex--;
  }
  return value.slice(0, endIndex);
}

export class GitHubIssueDropService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly aiPrompter: AiPrompter = openAiPrompter,
    private readonly botSigner: BotDeviceSigner = botDeviceSigner
  ) {}

  async postGhIssueDrop(
    targetUrl: string,
    targetKind: GitHubDropTargetKind = 'issue',
    options: PostGitHubDropOptions = {}
  ) {
    const privateKey = env.getStringOrThrow('GH_WEBHOOK_WALLET_PRIVATE_KEY');
    const waveId = env.getStringOrThrow('GH_WEBHOOK_WAVE_ID');

    let wallet: Wallet;
    try {
      wallet = new Wallet(privateKey.trim());
    } catch {
      // The library's error repeats the key; never pass it on.
      throw new Error('GH_WEBHOOK_WALLET_PRIVATE_KEY is not a private key');
    }
    const clientAddress = wallet.address;

    this.logger.info(
      `Authenticating as ${clientAddress} to post GitHub ${targetKind} drop`
    );

    const token = await this.getAuthToken(wallet, clientAddress);
    const content = await this.buildDropContent({
      targetUrl,
      targetKind,
      options
    });
    await this.createDrop(token, clientAddress, waveId, content);

    this.logger.info(
      `Successfully posted drop for GitHub ${targetKind}: ${targetUrl}`
    );
  }

  private async getAuthToken(
    wallet: Wallet,
    clientAddress: string
  ): Promise<string> {
    const API_BASE_URL =
      env.getStringOrNull('API_BASE_URL') ?? 'https://api.6529.io';
    const sessionNonceUrl = this.buildApiUrl(
      API_BASE_URL,
      '/api/auth/session-nonce',
      {
        signer_address: clientAddress,
        client_type: GITHUB_WEBHOOK_AUTH_CLIENT_TYPE
      }
    );
    const nonceResp = await fetch(sessionNonceUrl, {
      headers: { accept: 'application/json' },
      method: 'GET'
    });

    if (!nonceResp.ok) {
      throw new Error(
        `Failed to get session nonce: ${nonceResp.status} ${nonceResp.statusText}`
      );
    }

    const sessionNonce = this.getValidatedSessionNonceResponse(
      await nonceResp.json(),
      clientAddress
    );

    const signedNonce = await wallet.signMessage(sessionNonce.signable_message);

    const loginUrl = this.buildApiUrl(API_BASE_URL, '/api/auth/login', {
      signer_address: clientAddress
    });
    const loginResp = await fetch(loginUrl, {
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      method: 'POST',
      body: JSON.stringify({
        client_address: clientAddress,
        client_signature: signedNonce,
        server_signature: sessionNonce.server_signature,
        is_safe_wallet: false
      })
    });

    if (!loginResp.ok) {
      throw new Error(
        `Failed to login: ${loginResp.status} ${loginResp.statusText}`
      );
    }

    return this.getValidatedLoginResponse(await loginResp.json()).token;
  }

  private getValidatedSessionNonceResponse(
    payload: unknown,
    clientAddress: string
  ): SessionNonceResponse {
    if (!isRecord(payload)) {
      throw new Error('Invalid session nonce response');
    }

    const signableMessage = getNonEmptyString(payload, 'signable_message');
    const serverSignature = getNonEmptyString(payload, 'server_signature');
    if (!signableMessage || !serverSignature) {
      throw new Error('Invalid session nonce response');
    }

    this.assertExpectedSessionNonceMessage(signableMessage, clientAddress);
    return {
      signable_message: signableMessage,
      server_signature: serverSignature
    };
  }

  private assertExpectedSessionNonceMessage(
    signableMessage: string,
    clientAddress: string
  ): void {
    const parsedMessage =
      parseStructuredWalletSignatureMessage(signableMessage);
    if (
      parsedMessage?.kind !== 'authentication' ||
      parsedMessage?.action !== 'login' ||
      parsedMessage?.domain !== GITHUB_WEBHOOK_AUTH_CLIENT_TYPE ||
      parsedMessage?.sessionType !== GITHUB_WEBHOOK_AUTH_CLIENT_TYPE ||
      parsedMessage?.wallet !== clientAddress.toLowerCase() ||
      parsedMessage?.expirationTime.getTime() <= Date.now()
    ) {
      throw new Error('Invalid session nonce response');
    }
  }

  private getValidatedLoginResponse(payload: unknown): LoginResponse {
    if (!isRecord(payload)) {
      throw new Error('Invalid login response');
    }

    const token = getNonEmptyString(payload, 'token');
    if (!token) {
      throw new Error('Invalid login response');
    }

    return { token };
  }

  private buildApiUrl(
    apiBaseUrl: string,
    path: string,
    query: Record<string, string>
  ): string {
    const url = new URL(apiBaseUrl);
    const basePath = removeTrailingSlashes(url.pathname);
    const nextPath = removeLeadingSlashes(path);
    url.pathname = [basePath, nextPath].filter(Boolean).join('/');
    Object.entries(query).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    return url.toString();
  }

  private async buildDropContent({
    targetUrl,
    targetKind,
    options
  }: {
    targetUrl: string;
    targetKind: GitHubDropTargetKind;
    options: PostGitHubDropOptions;
  }): Promise<string> {
    if (targetKind !== 'pull request' || options.action !== 'merged') {
      return targetUrl;
    }

    const summary = await this.summarizeMergedPullRequest({
      targetUrl,
      title: options.title,
      body: options.body
    });

    return `${targetUrl}\n\n${summary}`;
  }

  private async summarizeMergedPullRequest({
    targetUrl,
    title,
    body
  }: {
    targetUrl: string;
    title?: string;
    body?: string;
  }): Promise<string> {
    try {
      const reply = await this.aiPrompter.promptAndGetReply(
        this.buildPullRequestSummaryPrompt({
          targetUrl,
          title,
          body
        })
      );
      const summary = this.truncateText(
        reply.trim(),
        PULL_REQUEST_SUMMARY_MAX_LENGTH
      );

      return summary || this.buildFallbackMergedPullRequestSummary(title);
    } catch (err) {
      this.logger.warn(
        `Failed to summarize merged pull request ${targetUrl}: ${err}`
      );
      return this.buildFallbackMergedPullRequestSummary(title);
    }
  }

  private buildPullRequestSummaryPrompt({
    targetUrl,
    title,
    body
  }: {
    targetUrl: string;
    title?: string;
    body?: string;
  }): string {
    const prTitle = title ?? 'No title provided.';
    const prBody = body
      ? this.truncateText(body, PULL_REQUEST_PROMPT_BODY_MAX_LENGTH)
      : 'No description provided.';

    return [
      'Summarize this merged GitHub pull request in 1-2 sentences.',
      'Write for a non-developer audience and focus on what changed or improved.',
      'Avoid technical jargon unless it is essential.',
      'Use only the information provided. If details are sparse, say only what can be inferred.',
      'Return only the summary with no markdown, bullet points, or preamble.',
      '',
      `Pull request link: ${targetUrl}`,
      `Pull request title: ${prTitle}`,
      'Pull request description:',
      prBody
    ].join('\n');
  }

  private buildFallbackMergedPullRequestSummary(title?: string): string {
    if (title) {
      return `This pull request was merged: ${title}.`;
    }

    return 'This pull request was merged, but the webhook did not include enough detail to summarize the changes.';
  }

  private truncateText(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }

    return `${sliceWholeCodePoints(value, maxLength - 3)}...`;
  }

  private async createDrop(
    token: string,
    signerAddress: string,
    waveId: string,
    content: string
  ) {
    const body = {
      title: null,
      drop_type: 'CHAT',
      parts: [
        {
          content,
          quoted_drop: null,
          media: []
        }
      ],
      mentioned_users: [],
      referenced_nfts: [],
      metadata: [],
      signature: null,
      is_safe_signature: false,
      signer_address: signerAddress,
      wave_id: waveId
    };
    const API_BASE_URL =
      env.getStringOrNull('API_BASE_URL') ?? 'https://api.6529.io';
    const createDropUrl = this.buildApiUrl(API_BASE_URL, '/api/drops', {});
    const post = (payload: object) =>
      fetch(createDropUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

    // Signed with the bot's device key when it has one, so the drop reaches
    // the 6529 relays.
    const deviceSignature = await this.deviceSignature(
      API_BASE_URL,
      token,
      signerAddress,
      { kind: DeviceEventKind.POST, waveId, refs: [], body }
    );
    let resp = await post(
      deviceSignature ? { ...body, device_signature: deviceSignature } : body
    );
    if (deviceSignature && resp.status === 400) {
      const errorText = await resp.text();
      if (!errorText.includes(INVALID_DEVICE_SIGNATURE_CODE)) {
        throw new Error(
          `Create drop failed: ${resp.status} ${resp.statusText} - ${errorText}`
        );
      }
      this.logger.error(
        `GitHub drop device signature refused, posting it unsigned: ${errorText}`
      );
      resp = await post(body);
    }

    if (!resp.ok) {
      const errorText = await resp.text();
      if (
        resp.status === 403 &&
        errorText.includes(DEVICE_SIGNATURE_REQUIRED_CODE)
      ) {
        this.logger.error(
          `GitHub drop refused: the API requires a device signature the bot could not give: ${errorText}`
        );
        throw new GitHubDropRefusedError(errorText);
      }
      throw new Error(
        `Create drop failed: ${resp.status} ${resp.statusText} - ${errorText}`
      );
    }
  }

  /**
   * The device signature of a post, or undefined to post unsigned: when the
   * bot has no usable key, or when the API it posts to does not hold the
   * bot's grant (API_BASE_URL may name another deployment, whose database
   * never stored it).
   */
  private async deviceSignature(
    apiBaseUrl: string,
    token: string,
    signerAddress: string,
    target: SignedWriteTarget
  ): Promise<DeviceSignatureEnvelope | undefined> {
    const envelope = await this.botSigner.envelopeFor(
      await this.botSigner.profileIdOfWallet(signerAddress),
      target
    );
    if (!envelope) {
      return undefined;
    }
    try {
      const resp = await fetch(
        this.buildApiUrl(apiBaseUrl, '/api/device-grants', {}),
        {
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`
          },
          method: 'GET'
        }
      );
      const grants: unknown = resp.ok ? await resp.json() : [];
      const held =
        Array.isArray(grants) &&
        grants.some(
          (grant) =>
            isRecord(grant) &&
            grant.id === envelope.grant_id &&
            grant.revoked_at === null &&
            Number(grant.expires_at) > envelope.claimed_time
        );
      if (held) {
        return envelope;
      }
      this.logger.warn(
        `GitHub drop posted unsigned: the API at ${apiBaseUrl} holds no usable device grant ${envelope.grant_id} of the bot`
      );
    } catch (error) {
      this.logger.warn(
        `GitHub drop posted unsigned: the bot's device grant could not be checked: ${error}`
      );
    }
    return undefined;
  }
}

export const githubIssueDropService = new GitHubIssueDropService();
