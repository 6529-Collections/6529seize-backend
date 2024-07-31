import { discord, DiscordChannel } from '../discord';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';

export const handler = sentryContext.wrapLambdaHandler(async (event: any) => {
  await doInDbContext(async () => {
    const record = event.Records?.at(0)?.Sns;
    if (record) {
      const m = {
        Subject: record.Subject,
        Message: record.Message,
        Attributes: record.MessageAttributes
      };
      await discord.sendMessage(
        DiscordChannel.DEV_ALERTS,
        `Cloudwatch Alarm:\n\`\`\`\n${JSON.stringify(
          m,
          null,
          2
        )}\`\`\`\n<@&1162355330798325861>`
      );
    }
  });
});
