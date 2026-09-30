import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import catalog from '@/config/deploy-services.json';

it('keeps queued failures retryable with headroom, retention and operational alarms', () => {
  const document = YAML.parseDocument(
    readFileSync(path.join(__dirname, 'serverless.yaml'), 'utf8')
  );
  const config = document.toJS();
  const consumer = config.functions.websocketOutboundHandler;
  const event = consumer.events.find((item: { sqs?: unknown }) => item.sqs).sqs;
  const resources = config.resources.Resources;
  const source = resources.WebSocketOutboundQueue.Properties;
  expect(consumer.events).toContainEqual({ schedule: 'rate(1 minute)' });
  expect(resources.WebSocketOutboxAgeAlarm.Properties.TreatMissingData).toBe(
    'breaching'
  );
  expect(
    catalog.services.find(
      (service) => service.name === 'websocketOutboundHandler'
    )?.default_dependencies
  ).toContain('dbMigrationsLoop');
  expect(event.batchSize).toBe(1);
  expect(event.functionResponseType).toBe('ReportBatchItemFailures');
  expect(event.maximumConcurrency).toBeLessThan(consumer.reservedConcurrency);
  expect(source.VisibilityTimeout).toBeGreaterThanOrEqual(
    6 * config.provider.timeout
  );
  expect(source.FifoQueue).toBe(true);
  expect(source.ContentBasedDeduplication).toBe(true);
  expect(source.SqsManagedSseEnabled).toBe(true);
  expect(source.RedrivePolicy.maxReceiveCount).toBeGreaterThan(3);
  expect(
    resources.WebSocketOutboundDLQ.Properties.MessageRetentionPeriod
  ).toBeGreaterThan(source.MessageRetentionPeriod);
  expect(
    resources.WebSocketOutboundDLQAlarm.Properties.AlarmActions
  ).not.toHaveLength(0);
  expect(
    resources.WebSocketOutboundAgeAlarm.Properties.AlarmActions
  ).not.toHaveLength(0);
  for (const producer of [
    'api',
    'pushNotificationsHandler',
    'releaseNotesGenerationLoop',
    'helpBotReplyLoop',
    'nftLinkRefresherLoop',
    'dropMediaSanitizer',
    'attachmentsOrchestrator',
    'attachmentsProcessor'
  ]) {
    expect(
      catalog.services.find((service) => service.name === producer)
        ?.default_dependencies
    ).toContain('websocketOutboundHandler');
  }
});
