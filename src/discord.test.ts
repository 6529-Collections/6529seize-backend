import { Discord, DiscordChannel } from '@/discord';

describe('Discord.sendMessage', () => {
  const send = jest.fn();
  const discord = new Discord(async () => ({
    channels: { fetch: async () => ({ send }) }
  }));

  beforeAll(() => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      DISCORD_CHANNEL_DEV_ALERTS: 'dev-alerts',
      DISCORD_CHANNEL_OPENAI_BIO_CHECK_RESPONSES: 'bio-checks'
    });
  });

  beforeEach(() => {
    send.mockReset().mockImplementation(async (content: string) => {
      if (content.length > 2000) {
        throw new Error('content must be 2000 or fewer in length');
      }
    });
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it.each([1999, 2000])(
    'preserves messages of %i characters',
    async (length) => {
      const message = 'a'.repeat(length);

      await discord.sendMessage(DiscordChannel.DEV_ALERTS, message);

      expect(send.mock.calls).toEqual([[message]]);
    }
  );

  it('preserves whitespace and newlines in short messages', async () => {
    const message = '  Cloudwatch Alarm:\n```\n{}\n```\n  ';

    await discord.sendMessage(DiscordChannel.DEV_ALERTS, message);

    expect(send.mock.calls).toEqual([[message]]);
  });

  it.each(Object.values(DiscordChannel))(
    'trims oversized messages sent to %s',
    async (channel) => {
      const prefix = 'a'.repeat(2000);

      await discord.sendMessage(channel, `${prefix}excess content`);

      expect(send.mock.calls).toEqual([[prefix]]);
    }
  );

  it.each([2001, 10000])(
    'caps %i-character messages at 2000',
    async (length) => {
      await discord.sendMessage(DiscordChannel.DEV_ALERTS, 'a'.repeat(length));

      expect(send.mock.calls).toEqual([['a'.repeat(2000)]]);
    }
  );

  it('does not split an emoji at the cutoff', async () => {
    const prefix = 'a'.repeat(1999);

    await discord.sendMessage(DiscordChannel.DEV_ALERTS, `${prefix}🚨more`);

    expect(send.mock.calls).toEqual([[prefix]]);
  });

  it('preserves a complete emoji ending at the limit', async () => {
    const prefix = `${'a'.repeat(1998)}🚨`;

    await discord.sendMessage(DiscordChannel.DEV_ALERTS, `${prefix}more`);

    expect(send.mock.calls).toEqual([[prefix]]);
  });

  it('still propagates send failures', async () => {
    const error = new Error('Discord unavailable');
    send.mockRejectedValueOnce(error);

    await expect(
      discord.sendMessage(DiscordChannel.DEV_ALERTS, 'alarm')
    ).rejects.toBe(error);
  });
});
