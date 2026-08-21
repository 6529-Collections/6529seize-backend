import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('releaseNotesGenerationLoop infrastructure', () => {
  const serverless = readFileSync(join(__dirname, 'serverless.yaml'), 'utf8');

  it('uses a five-minute visibility timeout around the three-minute Lambda', () => {
    expect(serverless).toMatch(/^ {2}timeout: 180$/m);
    expect(serverless).toMatch(/^ {8}VisibilityTimeout: 300$/m);
    expect(serverless).toMatch(/^ {10}maxReceiveCount: 5$/m);
  });
});
