import fetch from 'node-fetch';
import { Logger } from './logging';

const logger = Logger.get('NOTIFIER_DISCORD');

export async function sendDiscordUpdate(
  webhookUrl: string,
  message: string,
  category: string,
  type?: 'success' | 'error' | 'info' | 'warn'
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
    let color = 255;
    let title = category;
    let shouldMention = false;
    switch (type) {
      case 'success':
        color = 65280;
        break;
      case 'error':
        color = 16711680;
        title += ' - ERROR';
        shouldMention = true;
        break;
      case 'warn':
        color = 16753920;
        title += ' - WARNING';
        shouldMention = true;
        break;
    }

    const embed = {
      color: color,
      description: message,
      title: title
    };
    postData = {
      embeds: [embed]
    };
    if (shouldMention) {
      postData.content = '<@&1162355330798325861>';
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
