import fetch from 'node-fetch';
import { Logger } from './logging';

const logger = Logger.get('NOTIFIER_DISCORD');

export async function sendDiscordUpdate(
  webhookUrl: string,
  message: string,
  category: string,
  type?: 'success' | 'error'
): Promise<void> {
  if (process.env.DISABLE_DISCORD_NOTIFICATIONS === 'true') {
    logger.info(`[DISCORD ${category} UPDATE SKIPPED] : [MESSAGE ${message}]`);
    return;
  }

  let postData: any;

  if (type) {
    const isSuccess = type === 'success';
    const embed = {
      color: isSuccess ? 65280 : 16711680,
      description: message,
      title: isSuccess ? `${category}` : `${category} - ERROR!`
    };
    postData = {
      embeds: [embed]
    };
    if (!isSuccess) {
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
