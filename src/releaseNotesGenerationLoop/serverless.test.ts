import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('releaseNotesGenerationLoop infrastructure', () => {
  const serverless = readFileSync(join(__dirname, 'serverless.yaml'), 'utf8');
  const handler = readFileSync(join(__dirname, 'index.ts'), 'utf8');

  it('delays initial queue delivery while GitHub settles the workflow', () => {
    expect(serverless).toMatch(/^ {8}DelaySeconds: 15$/m);
  });

  it('uses a five-minute visibility timeout around the three-minute Lambda', () => {
    expect(serverless).toMatch(/^ {2}timeout: 180$/m);
    expect(serverless).toMatch(/^ {8}VisibilityTimeout: 300$/m);
    expect(serverless).toMatch(/^ {10}maxReceiveCount: 5$/m);
    expect(handler).toContain(
      'const RELEASE_NOTE_PROCESSING_TTL_SECONDS = 4 * 60;'
    );
    expect(handler).toContain(
      'const RELEASE_NOTE_MINIMUM_PART_TIME_MS = 45_000;'
    );
  });
});
