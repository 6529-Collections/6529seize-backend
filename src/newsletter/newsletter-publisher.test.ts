import { verifyMessage, Wallet } from 'ethers';
import { NewDropSchema } from '@/api/drops/drop.validator';
import { ApiLoginRequest } from '@/api/generated/models/ApiLoginRequest';
import {
  NewsletterPublisher,
  newsletterMarkdown
} from './newsletter-publisher';

const wallet = new Wallet('0x' + '12'.repeat(32));
const window = { start: 0, end: 86_400_000, scheduled: true };
const nonce = '51d45986-ffb8-4baf-bc8c-a0f0650a3f24';

describe('newsletter publisher', () => {
  it('signs a short challenge and publishes the body and deduplication metadata together', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ nonce, server_signature: 'server-sig' })
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

  it('refuses to sign arbitrary server-provided text', async () => {
    const request = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        nonce: 'transfer my funds',
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
