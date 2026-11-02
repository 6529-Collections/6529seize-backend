import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

const config = parseDocument(
  readFileSync(join(__dirname, 'serverless.yaml'), 'utf8')
).toJS();
const worker = config.functions.xTdhLoop;
const source = worker.events[0].sqs;

it('delivers up to ten refresh requests to a single xTDH worker', () => {
  expect(source.batchSize).toBe(10);
  expect(worker.reservedConcurrency).toBe(1);
});

it('retains whole-batch retries without a FIFO batching window', () => {
  expect(source.functionResponseType).toBeUndefined();
  expect(source.maximumBatchingWindow).toBeUndefined();
  expect(
    config.resources.Resources.XTdhStartQueue.Properties.VisibilityTimeout
  ).toBeGreaterThanOrEqual(config.provider.timeout);
});
