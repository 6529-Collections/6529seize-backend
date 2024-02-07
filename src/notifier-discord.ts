import fetch from 'node-fetch';
import { Logger } from './logging';

const logger = Logger.get('NOTIFIER_DISCORD');

export async function sendDiscordUpdate(
  webhookUrl: string,
  message: string,
  category: string
): Promise<void> {
  const postData = {
    content: message
  };

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
