import { Wallet } from 'ethers';
import fetch from 'node-fetch';
import { env } from '../../../env';
import { Logger } from '../../../logging';

export class GitHubIssueDropService {
  private readonly logger = Logger.get(this.constructor.name);

  async postGhIssueDrop(issueUrl: string) {
    const privateKey = env.getStringOrThrow('GH_WEBHOOK_WALLET_PRIVATE_KEY');
    const waveId = env.getStringOrThrow('GH_WEBHOOK_WAVE_ID');

    const wallet = new Wallet(privateKey);
    const clientAddress = wallet.address;

    this.logger.info(
      `Authenticating as ${clientAddress} to post GitHub issue drop`
    );

    const token = await this.getAuthToken(wallet, clientAddress);
    await this.createDrop(token, clientAddress, waveId, issueUrl);

    this.logger.info(`Successfully posted drop for issue: ${issueUrl}`);
  }

  private async getAuthToken(
    wallet: Wallet,
    clientAddress: string
  ): Promise<string> {
    const API_BASE_URL =
      env.getStringOrNull('API_BASE_URL') ?? 'https://api.6529.io';
    const nonceResp = await fetch(
      `${API_BASE_URL}/api/auth/nonce?signer_address=${clientAddress}&short_nonce=true`,
      {
        headers: { accept: 'application/json' },
        method: 'GET'
      }
    );

    if (!nonceResp.ok) {
      throw new Error(
        `Failed to get nonce: ${nonceResp.status} ${nonceResp.statusText}`
      );
    }

    const { nonce, server_signature } = await nonceResp.json();

    const signedNonce = await wallet.signMessage(nonce);

    const loginResp = await fetch(
      `${API_BASE_URL}/api/auth/login?signer_address=${clientAddress}`,
      {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
          client_address: clientAddress,
          client_signature: signedNonce,
          server_signature
        })
      }
    );

    if (!loginResp.ok) {
      throw new Error(
        `Failed to login: ${loginResp.status} ${loginResp.statusText}`
      );
    }

    const { token } = await loginResp.json();
    return token;
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

    const resp = await fetch(`${API_BASE_URL}/api/drops`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(
        `Create drop failed: ${resp.status} ${resp.statusText} - ${errorText}`
      );
    }
  }
}

export const githubIssueDropService = new GitHubIssueDropService();
