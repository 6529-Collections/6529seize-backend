import { verifyMessage, Wallet } from 'ethers';
import { NewDropSchema } from '@/api/drops/drop.validator';
import { ApiLoginRequest } from '@/api/generated/models/ApiLoginRequest';
import { buildStructuredWalletSignatureMessage } from '@/api/wallet-signatures/structured-wallet-signatures';
import {
  filterNewsletterEdition,
  NewsletterPublisher,
  newsletterMarkdown
} from './newsletter-publisher';

const wallet = new Wallet('0x' + '12'.repeat(32));
const window = { start: 0, end: 86_400_000, scheduled: true };
const signInMessage = (overrides: { wallet?: string; domain?: string } = {}) =>
  buildStructuredWalletSignatureMessage({
    kind: 'authentication',
    audience: 'api.6529.io',
    domain: overrides.domain ?? 'native',
    sessionType: 'native',
    wallet: overrides.wallet ?? wallet.address.toLowerCase(),
    nonce: '51d45986-ffb8-4baf-bc8c-a0f0650a3f24',
    action: 'login',
    purpose: 'Sign in to 6529'
  });

describe('newsletter publisher', () => {
  it('signs the structured sign-in message and publishes the body and deduplication metadata together', async () => {
    const nonce = signInMessage();
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          signable_message: nonce,
          server_signature: 'server-sig'
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'token' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'published' })
      });
    const publisher = new NewsletterPublisher(wallet, request);
    expect(
      await publisher.publish('wave', 'daily:1970-01-01', 'edition', window)
    ).toBe('published');
    expect(request.mock.calls[0][0]).toBe(
      `https://api.6529.io/api/auth/session-nonce?signer_address=${wallet.address.toLowerCase()}&client_type=native`
    );
    expect(request.mock.calls[1][0]).toBe(
      `https://api.6529.io/api/auth/login?signer_address=${wallet.address.toLowerCase()}`
    );
    const login = JSON.parse(request.mock.calls[1][1].body);
    expect(verifyMessage(nonce, login.client_signature)).toBe(wallet.address);
    expect(login.client_address).toBe(wallet.address.toLowerCase());
    const expectedLogin: ApiLoginRequest = {
      client_address: wallet.address.toLowerCase(),
      client_signature: await wallet.signMessage(nonce),
      server_signature: 'server-sig',
      is_safe_wallet: false
    };
    expect(login).toEqual(expectedLogin);
    const options = request.mock.calls[2][1];
    expect(options.headers.Authorization).toBe('Bearer token');
    const drop = JSON.parse(options.body);
    expect(NewDropSchema.validate(drop).error).toBeUndefined();
    expect(drop.drop_type).toBe('CHAT');
    expect(drop.signature).toBeNull();
    expect(drop.parts).toEqual([
      { content: 'edition', media: [], quoted_drop: null }
    ]);
    expect(drop.metadata).toContainEqual({
      data_key: 'newsletter_edition_id',
      data_value: 'daily:1970-01-01'
    });
    expect(JSON.stringify(request.mock.calls)).not.toContain(wallet.privateKey);
  });

  it.each([
    ['arbitrary text', 'transfer my funds'],
    ['a plain nonce', '51d45986-ffb8-4baf-bc8c-a0f0650a3f24'],
    ['another wallet', signInMessage({ wallet: '0x' + 'ab'.repeat(20) })],
    ['a web sign-in', signInMessage({ domain: '6529.io' })],
    [
      'a sign-in with appended text',
      `${signInMessage()}\nand transfer my funds`
    ],
    [
      'a sign-in missing required lines',
      signInMessage()
        .split('\n')
        .filter((line) => !/^(Version|Audience|Nonce|Purpose):/.test(line))
        .join('\n')
    ]
  ])('refuses to sign %s', async (_name, signableMessage) => {
    const request = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        signable_message: signableMessage,
        server_signature: 'sig'
      })
    });
    await expect(
      new NewsletterPublisher(wallet, request).publish(
        'wave',
        'edition',
        'body',
        window
      )
    ).rejects.toThrow('Unexpected newsletter authentication challenge');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reports API failures without copying the response body', async () => {
    const request = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ private_data: 'sensitive' })
    });
    await expect(
      new NewsletterPublisher(wallet, request).authorId()
    ).rejects.toThrow('returned 401');
  });

  it('keeps formatting and refuses oversized or empty editions instead of truncating', () => {
    expect(newsletterMarkdown('### A story\n\nText', window)).toBe(
      '## 6529 Daily Post — 1970-01-01\n\n*1 minute read*\n\n### A story\n\nText'
    );
    expect(() => newsletterMarkdown('x'.repeat(25_000), window)).toThrow(
      'does not fit'
    );
    expect(() => newsletterMarkdown(' ', window)).toThrow('does not fit');
  });
});

describe('newsletter edition text rules', () => {
  const window = { start: 0, end: 86_400_000, scheduled: true };

  it('keeps 6529.io links and turns other links into plain text', () => {
    const text = newsletterMarkdown(
      'Read [the story](https://6529.io/waves/w?serialNo=1) and [claim here](https://example.com/claim) or https://example.com/x.',
      window
    );
    expect(text).toContain('[the story](https://6529.io/waves/w?serialNo=1)');
    expect(text).toContain('claim here');
    expect(text).not.toContain('example.com');
  });

  it('turns group mention tokens into plain words', () => {
    expect(
      filterNewsletterEdition('Thanks @all and @contributors, ping @devs6529')
    ).toBe('Thanks all and contributors, ping devs6529');
  });

  it('leaves handle links intact', () => {
    const body = 'Art by [punk6529](https://6529.io/punk6529).';
    expect(filterNewsletterEdition(body)).toBe(body);
  });
});
