import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import catalog from '@/config/deploy-services.json';

it('permits only production deployment and schedules a serialized UTC-midnight worker', () => {
  const service = catalog.services.find(
    (entry) => entry.name === 'newsletterLoop'
  );
  expect(service?.allowed_environments).toEqual(['prod']);
  expect(service?.default_dependencies).toEqual([]);
  const yaml = parse(readFileSync(join(__dirname, 'serverless.yaml'), 'utf8'));
  expect(yaml.functions.newsletterLoop.reservedConcurrency).toBe(1);
  expect(yaml.functions.newsletterLoop.events).toEqual([
    { schedule: { rate: 'cron(0 0 * * ? *)', enabled: true } }
  ]);
  expect(yaml.functions.newsletterLoop.environment.NEWSLETTER_STAGE).toBe(
    '${opt:stage, self:provider.stage}'
  );
  const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
  expect(pkg.scripts['sls-deploy:staging']).toBeUndefined();
});
