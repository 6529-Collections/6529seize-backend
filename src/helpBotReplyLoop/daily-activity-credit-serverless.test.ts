import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('helpBotReplyLoop daily activity credit infrastructure', () => {
  const serverless = readFileSync(
    resolve(__dirname, 'serverless.yaml'),
    'utf8'
  );

  it('isolates serialized credit work from normal reply capacity', () => {
    expect(serverless).toContain('handler: index.dailyActivityCreditHandler');
    expect(serverless).toContain('name: helpBotDailyActivityCreditLoop');
    expect(serverless).toMatch(/^ {4}reservedConcurrency: 1$/m);
    expect(serverless).toContain(
      'QueueName: help-bot-daily-activity-credits.fifo'
    );
    expect(serverless).toContain('FifoQueue: true');
    expect(serverless).toContain(
      'MessageGroupId: help-bot-daily-activity-credits'
    );
  });

  it('uses an EventBridge queue wakeup when post-commit publication fails', () => {
    expect(serverless).toContain('Type: AWS::Events::Rule');
    expect(serverless).toContain('ScheduleExpression: rate(1 minute)');
    expect(serverless).toContain('Service: events.amazonaws.com');
  });

  it('retains failed wakeups in an alarmed DLQ and alarms on dead rows', () => {
    expect(serverless).toContain(
      'QueueName: help-bot-daily-activity-credits-dlq.fifo'
    );
    expect(serverless).toMatch(/^ {10}maxReceiveCount: 5$/m);
    expect(serverless).toContain(
      'MetricName: ApproximateNumberOfMessagesVisible'
    );
    expect(serverless).toContain(
      "FilterPattern: 'HELP_BOT_DAILY_ACTIVITY_CREDIT_REQUEST_DEAD'"
    );
  });
});
