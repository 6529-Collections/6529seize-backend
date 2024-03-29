import fetch from 'node-fetch';
import { Logger } from './logging';

const logger = Logger.get('NOTIFIER_DISCORD');

export async function sendDiscordUpdate(
  webhookUrl: string,
  message: string,
  category: string,
  type?: 'success' | 'error' | 'info'
): Promise<void> {
  if (process.env.DISABLE_DISCORD_NOTIFICATIONS === 'true') {
    logger.info(`[DISCORD ${category} UPDATE SKIPPED] : [MESSAGE ${message}]`);
    return;
  }

  if (!webhookUrl) {
    logger.error(`[DISCORD ${category} UPDATE ERROR] : [NO WEBHOOK URL]`);
    return;
  }

  let postData: any;

  if (type) {
    const isSuccess = type === 'success';
    const isError = type === 'error';

    const embed = {
      color: isSuccess ? 65280 : isError ? 16711680 : 255,
      description: message,
      title: isError ? `${category} - ERROR` : `${category}!`
    };
    postData = {
      embeds: [embed]
    };
    if (isError) {
      postData.content = '@everyone';
    }
  } else {
    postData = {
      content: message
    };
  }

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(postData)
    });
    logger.info(`[DISCORD ${category} UPDATE SENT] : [MESSAGE ${message}]`);
  } catch (error) {
    logger.error(`[DISCORD ${category} UPDATE ERROR] : [${error}]`);
  }
}
