import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

it('keeps continuation delivery separate from the application failure budget', () => {
  // CloudFormation tags remain unresolved; these settings are plain YAML.
  const document = parseDocument(
    readFileSync(join(__dirname, 'serverless.yaml'), 'utf8')
  );
  expect(document.errors).toEqual([]);
  const config = document.toJS();
  expect(config.provider.memorySize).toBe(4096);
  expect(config.provider.timeout).toBe(900);
  expect(
    config.functions.claimsMediaArweaveUploader.events[0].sqs
      .functionResponseType
  ).toBe('ReportBatchItemFailures');
  expect(
    config.resources.Resources.ClaimsMediaArweaveUploadQueue.Properties
  ).toMatchObject({
    VisibilityTimeout: 930,
    RedrivePolicy: { maxReceiveCount: 1000 }
  });
});
