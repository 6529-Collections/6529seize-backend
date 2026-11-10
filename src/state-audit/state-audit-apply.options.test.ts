import {
  DEFAULT_MAX_MANIFEST_AGE_HOURS,
  parseStateAuditApplyCommand
} from './state-audit-apply.options';
import { StateAuditUsageError } from './state-audit.options';

const DIGEST = 'a'.repeat(64);
const JOB = '7d0f3c1e-8b2a-4c5d-9e6f-0a1b2c3d4e5f';
const REQUIRED = [
  '--manifest',
  'm.json',
  '--plan-digest',
  DIGEST,
  '--job-id',
  JOB
];

describe('state audit apply CLI options', () => {
  it.each([[], ['--help'], ['help'], ['-h'], [...REQUIRED, '--help']])(
    'selects help for %j without parsing anything else',
    (...args) => {
      expect(parseStateAuditApplyCommand(args)).toEqual({
        command: 'apply-help'
      });
    }
  );

  it('defaults to a dry run with the default manifest age limit', () => {
    expect(parseStateAuditApplyCommand(REQUIRED)).toEqual({
      command: 'apply',
      request: {
        manifestPath: 'm.json',
        planDigest: DIGEST,
        jobId: JOB,
        live: false,
        maxManifestAgeHours: DEFAULT_MAX_MANIFEST_AGE_HOURS
      }
    });
  });

  it('accepts --live, a custom age limit and normalizes digest and job id case', () => {
    const upper = [
      '--manifest',
      'm.json',
      '--plan-digest',
      DIGEST.toUpperCase(),
      '--job-id',
      JOB.toUpperCase(),
      '--live',
      '--max-age-hours',
      '24'
    ];
    expect(parseStateAuditApplyCommand(upper)).toEqual({
      command: 'apply',
      request: {
        manifestPath: 'm.json',
        planDigest: DIGEST,
        jobId: JOB,
        live: true,
        maxManifestAgeHours: 24
      }
    });
  });

  it.each([
    [['--plan-digest', DIGEST, '--job-id', JOB], '--manifest is required'],
    [['--manifest', 'm', '--job-id', JOB], '--plan-digest is required'],
    [['--manifest', 'm', '--plan-digest', DIGEST], '--job-id is required'],
    [[...REQUIRED.slice(0, 3), 'abc', ...REQUIRED.slice(4)], '64-character'],
    [[...REQUIRED.slice(0, 5), 'not-a-uuid'], 'UUID v4'],
    [[...REQUIRED, '--max-age-hours', '0'], 'between 1 and'],
    [[...REQUIRED, '--max-age-hours', 'x'], 'whole decimal'],
    [[...REQUIRED, '--live', '--live'], 'must not be repeated'],
    [[...REQUIRED.slice(0, 5)], 'requires a value'],
    [[...REQUIRED, '--out', 'f'], 'Unknown option']
  ])('rejects %j', (args, message) => {
    expect(() => parseStateAuditApplyCommand(args)).toThrow(
      StateAuditUsageError
    );
    expect(() => parseStateAuditApplyCommand(args)).toThrow(message);
  });
});
