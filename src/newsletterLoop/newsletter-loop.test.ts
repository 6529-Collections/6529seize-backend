jest.mock('@/env', () => ({ prepEnvironment: jest.fn() }));
jest.mock('@/secrets', () => ({
  doInDbContext: jest.fn(async (fn: () => Promise<unknown>) => fn())
}));
jest.mock('@/newsletter/newsletter.service', () => ({
  publishNewsletter: jest.fn().mockResolvedValue({ status: 'published' })
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: jest.fn((fn: unknown) => fn)
}));

import { Wallet } from 'ethers';
import { prepEnvironment } from '@/env';
import { doInDbContext } from '@/secrets';
import { publishNewsletter } from '@/newsletter/newsletter.service';
import { runNewsletter } from './index';

const original = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...original };
  delete process.env.NEWSLETTER_TARGET_WAVE_ID;
  delete process.env.NEWSLETTER_PUBLISHER_WALLET;
  delete process.env.NEWSLETTER_PUBLISHER_PRIVATE_KEY;
});
afterEach(() => {
  process.env = original;
  jest.restoreAllMocks();
});

it('does nothing outside production before loading shared secrets', async () => {
  process.env.NEWSLETTER_STAGE = 'staging';
  expect(await runNewsletter({})).toEqual({ status: 'not-production' });
  expect(prepEnvironment).not.toHaveBeenCalled();
  expect(doInDbContext).not.toHaveBeenCalled();
});

it('successfully exits with incomplete configuration, even for a malformed event', async () => {
  process.env.NEWSLETTER_STAGE = 'prod';
  expect(
    await runNewsletter({
      source: 'aws.events',
      'detail-type': 'Scheduled Event'
    })
  ).toEqual({ status: 'not-configured' });
  expect(doInDbContext).not.toHaveBeenCalled();
  expect(publishNewsletter).not.toHaveBeenCalled();
});

it('captures the manual window before initialization and runs without Redis', async () => {
  process.env.NEWSLETTER_STAGE = 'prod';
  process.env.NEWSLETTER_TARGET_WAVE_ID =
    '54a4d79f-a9ce-45e7-bdc7-d772226b2577';
  process.env.NEWSLETTER_PUBLISHER_PRIVATE_KEY = '0x' + '12'.repeat(32);
  process.env.NEWSLETTER_PUBLISHER_WALLET = new Wallet(
    process.env.NEWSLETTER_PUBLISHER_PRIVATE_KEY
  ).address;
  const now = Date.parse('2026-09-24T14:37:00Z');
  jest.spyOn(Date, 'now').mockReturnValue(now);
  await runNewsletter({});
  expect(publishNewsletter).toHaveBeenCalledWith(
    expect.anything(),
    { start: now - 86_400_000, end: now, scheduled: false },
    expect.anything()
  );
  expect(doInDbContext).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({ skipRedis: true })
  );
});
