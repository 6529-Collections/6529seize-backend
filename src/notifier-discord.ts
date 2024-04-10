import fetch from 'node-fetch';
import { Logger } from './logging';

const logger = Logger.get('NOTIFIER_DISCORD');

const DISCORD_DEVS_ROLE = '<@&1162355330798325861>';

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
    let shouldMentionDevs = false;
    switch (type) {
      case 'success':
        color = 65280;
        break;
      case 'error':
        color = 16711680;
        title += ' - ERROR';
        shouldMentionDevs = true;
        break;
      case 'warn':
        color = 16753920;
        title += ' - WARNING';
        shouldMentionDevs = true;
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
    if (shouldMentionDevs) {
      postData.content = DISCORD_DEVS_ROLE;
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
