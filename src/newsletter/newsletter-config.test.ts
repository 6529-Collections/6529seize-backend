import { Wallet } from 'ethers';
import { newsletterWindow, readNewsletterConfig } from './newsletter.config';

const key = '0x' + '12'.repeat(32); // Disposable test wallet, never funded.
const settings = {
  NEWSLETTER_TARGET_WAVE_ID: '54a4d79f-a9ce-45e7-bdc7-d772226b2577',
  NEWSLETTER_PUBLISHER_WALLET: new Wallet(key).address,
  NEWSLETTER_PUBLISHER_PRIVATE_KEY: key
};

describe('newsletter configuration and time windows', () => {
  it.each(Object.keys(settings))('disables all work without %s', (missing) => {
    expect(readNewsletterConfig({ ...settings, [missing]: '  ' })).toBeNull();
    expect(
      readNewsletterConfig({ NEWSLETTER_PUBLISHER_PRIVATE_KEY: 'invalid' })
    ).toBeNull();
  });

  it('checks the key matches the configured wallet without leaking it', () => {
    expect(readNewsletterConfig(settings)?.modelId).toBe(
      'global.openai.gpt-6-astra'
    );
    expect(() =>
      readNewsletterConfig({
        ...settings,
        NEWSLETTER_PUBLISHER_WALLET: Wallet.createRandom().address
      })
    ).toThrow('does not match');
    expect(() =>
      readNewsletterConfig({
        ...settings,
        NEWSLETTER_PUBLISHER_PRIVATE_KEY: 'secret-invalid-key'
      })
    ).toThrow('Invalid newsletter publisher private key');
  });

  it('uses the original scheduled day on a delayed retry across a month boundary', () => {
    const result = newsletterWindow(
      {
        source: 'aws.events',
        'detail-type': 'Scheduled Event',
        time: '2026-10-01T00:00:00Z',
        date: '2026-09-24'
      },
      Date.parse('2026-10-03T12:00:00Z')
    );
    expect(result).toEqual({
      start: Date.parse('2026-09-30T00:00:00Z'),
      end: Date.parse('2026-10-01T00:00:00Z'),
      scheduled: true
    });
  });

  it.each([{}, undefined, null, { time: '2020-01-01T00:00:00Z' }])(
    'uses the rolling window for a manual invocation: %j',
    (event) => {
      const now = Date.parse('2026-09-24T14:37:52Z');
      expect(newsletterWindow(event, now)).toEqual({
        start: now - 86_400_000,
        end: now,
        scheduled: false
      });
    }
  );

  it('selects a complete UTC day as a fresh manual edition when a date is supplied', () => {
    expect(
      newsletterWindow(
        { date: '2026-09-24' },
        Date.parse('2026-09-25T14:37:52Z')
      )
    ).toEqual({
      start: Date.parse('2026-09-24T00:00:00Z'),
      end: Date.parse('2026-09-25T00:00:00Z'),
      scheduled: false
    });
  });

  it.each([
    '2026-02-30',
    '2026-13-01',
    '2026-9-24',
    '2026-09-24T00:00:00Z',
    '',
    null,
    123
  ])(
    'rejects an invalid manual date instead of publishing a different day: %j',
    (date) => {
      expect(() => newsletterWindow({ date })).toThrow(
        'Manual newsletter date must be a valid YYYY-MM-DD'
      );
    }
  );

  it('rejects malformed scheduled timestamps instead of changing the edition', () => {
    expect(() =>
      newsletterWindow({
        source: 'aws.events',
        'detail-type': 'Scheduled Event',
        time: 'bad'
      })
    ).toThrow('invalid event timestamp');
  });
});
