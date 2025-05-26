const { Client, GatewayIntentBits } = require('discord.js');

let discordInstance: any | null = null;

async function getDiscordInstance(): Promise<any> {
  if (!discordInstance) {
    discordInstance = new Client({ intents: [GatewayIntentBits.Guilds] });
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      throw new Error(
        `Environment variable DISCORD_BOT_TOKEN is not configured`
      );
    }
    await discordInstance.login(token);
  }
  return discordInstance;
}

export enum DiscordChannel {
  OPENAI_BIO_CHECK_RESPONSES = 'OPENAI_BIO_CHECK_RESPONSES',
  DEV_ALERTS = 'DEV_ALERTS'
}

const CHANNELS_TO_CHANNEL_IDS: Partial<Record<DiscordChannel, any>> = {};

export class Discord {
  constructor(private readonly supplyDiscord: () => Promise<any>) {}

  async sendMessage(channel: DiscordChannel, message: string): Promise<void> {
    const textChannel = await this.getTextChannel(channel);
    await textChannel.send(message);
  }

  private async getTextChannel(channel: DiscordChannel): Promise<any> {
    if (!CHANNELS_TO_CHANNEL_IDS[channel]) {
      const discord = await this.supplyDiscord();
      const channelId = process.env[`DISCORD_CHANNEL_${channel}`];
      if (!channelId) {
        throw new Error(
          `Environment variable DISCORD_CHANNEL_${channel} is not configured`
        );
      }
      CHANNELS_TO_CHANNEL_IDS[channel] =
        await discord.channels.fetch(channelId);
    }
    return CHANNELS_TO_CHANNEL_IDS[channel]!;
  }
}

export const discord = new Discord(getDiscordInstance);
