import { Wallet } from 'ethers';
import MarkdownIt from 'markdown-it';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import { ApiNonceResponse } from '@/api/generated/models/ApiNonceResponse';
import { ApiLoginResponse } from '@/api/generated/models/ApiLoginResponse';
import { ApiLoginRequest } from '@/api/generated/models/ApiLoginRequest';
import { NewsletterWindow } from './newsletter.config';

const API = 'https://api.6529.io/api';
const markdown = new MarkdownIt({ html: false, linkify: false });
const READING_WORDS_PER_MINUTE = 250;

export function newsletterMarkdown(
  body: string,
  window: NewsletterWindow
): string {
  const day = new Date(window.start).toISOString().slice(0, 10);
  // Count visible prose and link labels, excluding Markdown syntax and URLs.
  const prose = markdown
    .parse(body, {})
    .flatMap((token) => token.children ?? [])
    .filter((token) => token.type === 'text' || token.type === 'code_inline')
    .map((token) => token.content)
    .join(' ');
  const wordCount = prose.match(/\S+/g)?.length ?? 0;
  const minutes = Math.max(1, Math.ceil(wordCount / READING_WORDS_PER_MINUTE));
  const text = `## 6529 Daily Post — ${day}\n\n*${minutes} minute read*\n\n${body.trim()}`;
  // One formatted drop; reject an incomplete/oversized answer rather than truncate it.
  if (
    !body.trim() ||
    text.length > 25_000 ||
    Buffer.byteLength(text, 'utf8') > 65_535
  ) {
    throw new Error('Newsletter does not fit in one drop');
  }
  return text;
}

export class NewsletterPublisher {
  private token: string | undefined;

  constructor(
    private readonly wallet: Wallet,
    private readonly request: typeof fetch = fetch
  ) {}

  private async api<T>(route: string, body?: unknown): Promise<T> {
    const response = await this.request(API + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
      // Never log request bodies, tokens, signatures, or provider response bodies.
      throw new Error(
        `Newsletter API ${route.split('?')[0]} returned ${response.status}`
      );
    }
    return (await response.json()) as T;
  }

  async authorId(): Promise<string> {
    const identity = await this.api<ApiIdentity>(
      `/identities/${this.wallet.address.toLowerCase()}`
    );
    if (!identity.id)
      throw new Error('Newsletter publisher has no 6529 profile');
    return identity.id;
  }

  private async login(): Promise<void> {
    const address = this.wallet.address.toLowerCase();
    const challenge = await this.api<ApiNonceResponse>(
      `/auth/nonce?signer_address=${address}&short_nonce=true`
    );
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        challenge.nonce
      )
    ) {
      throw new Error('Unexpected newsletter authentication challenge');
    }
    const loginRequest: ApiLoginRequest = {
      client_address: address,
      client_signature: await this.wallet.signMessage(challenge.nonce),
      server_signature: challenge.server_signature,
      is_safe_wallet: false
    };
    const session = await this.api<ApiLoginResponse>(
      `/auth/login?signer_address=${address}`,
      loginRequest
    );
    if (!session.token)
      throw new Error('Newsletter authentication returned no token');
    this.token = session.token;
  }

  async publish(
    waveId: string,
    editionId: string,
    markdown: string,
    window: NewsletterWindow
  ): Promise<string> {
    await this.login();
    const request: ApiCreateDropRequest = {
      wave_id: waveId,
      drop_type: ApiDropType.Chat,
      parts: [{ content: markdown, media: [], quoted_drop: null }],
      referenced_nfts: [],
      mentioned_users: [],
      metadata: [
        { data_key: 'newsletter_edition_id', data_value: editionId },
        {
          data_key: 'newsletter_window_start',
          data_value: new Date(window.start).toISOString()
        },
        {
          data_key: 'newsletter_window_end',
          data_value: new Date(window.end).toISOString()
        },
        {
          data_key: 'newsletter_mode',
          data_value: window.scheduled ? 'scheduled' : 'manual'
        }
      ],
      signature: null,
      hide_link_preview: true
    };
    const drop = await this.api<ApiDrop>('/drops', request);
    if (!drop.id) throw new Error('Newsletter publication returned no drop ID');
    return drop.id;
  }
}
