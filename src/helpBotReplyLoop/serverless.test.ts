import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HELP_BOT_ANSWERING_LEASE_MS } from '@/help-bot/help-bot.config';

describe('helpBotReplyLoop reply queue timing', () => {
  const serverless = readFileSync(
    resolve(__dirname, 'serverless.yaml'),
    'utf8'
  );

  function readLambdaTimeoutSeconds(): number {
    const match = /^provider:[\s\S]*?^ {2}timeout: (\d+)$/m.exec(serverless);
    if (!match) {
      throw new Error('provider timeout not found');
    }
    return Number(match[1]);
  }

  function readRepliesQueueVisibilitySeconds(): number {
    const match =
      /QueueName: help-bot-replies\n\s+VisibilityTimeout: (\d+)/.exec(
        serverless.split('\r\n').join('\n')
      );
    if (!match) {
      throw new Error('help-bot-replies visibility timeout not found');
    }
    return Number(match[1]);
  }

  it('outlasts a running attempt with the answering lease', () => {
    expect(HELP_BOT_ANSWERING_LEASE_MS).toBeGreaterThan(
      readLambdaTimeoutSeconds() * 1000
    );
  });

  it('lets a redelivered message reclaim the answering lease', () => {
    expect(HELP_BOT_ANSWERING_LEASE_MS).toBeLessThan(
      readRepliesQueueVisibilitySeconds() * 1000
    );
  });
});
