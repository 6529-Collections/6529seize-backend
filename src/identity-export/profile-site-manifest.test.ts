import { createHash } from 'node:crypto';
import { profileSiteManifestProblem } from './profile-site-manifest';

const T = Date.UTC(2026, 10, 24);
const CMS = createHash('sha256').update('{}').digest('hex');

function manifest(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: '6529.profile-site-export.manifest.v1',
    usable: true,
    rehearsal: false,
    stage: 'prod',
    frozen_at: '2026-11-24T00:00:00.000Z',
    files: [
      { name: 'files/bafk1', bytes: 1, sha256: 'b'.repeat(64) },
      { name: 'cms-fields.json', bytes: 2, sha256: CMS }
    ],
    ...over
  });
}

describe('profileSiteManifestProblem', () => {
  it('takes a whole, usable run of the freeze that lists the file', () => {
    expect(profileSiteManifestProblem(manifest(), CMS, T, 'prod')).toBeNull();
    expect(profileSiteManifestProblem(manifest(), CMS, T)).toBeNull();
  });

  it("takes a rehearsal's run in a rehearsal, still by the file's sha256", () => {
    const run = manifest({ usable: false, rehearsal: true, frozen_at: 'x' });
    expect(profileSiteManifestProblem(run, CMS, null)).toBeNull();
    expect(profileSiteManifestProblem(run, '0'.repeat(64), null)).toContain(
      'lists cms-fields.json with sha256'
    );
  });

  it.each([
    ['not json', 'is not JSON'],
    ['[]', 'is not a JSON object'],
    [manifest({ schema: 'other' }), 'schema is "other"'],
    [manifest({ usable: false }), 'not of a whole, usable run'],
    [manifest({ rehearsal: true }), 'not of a whole, usable run'],
    [
      manifest({ frozen_at: '2026-11-23T00:00:00.000Z' }),
      'exported the freeze "2026-11-23T00:00:00.000Z", not 2026-11-24T00:00:00.000Z'
    ],
    [manifest({ stage: 'staging' }), 'is of the stage "staging", not prod'],
    [manifest({ files: [] }), 'lists cms-fields.json 0 times, not once'],
    [
      manifest({
        files: [
          { name: 'cms-fields.json', sha256: CMS },
          { name: 'cms-fields.json', sha256: CMS }
        ]
      }),
      'lists cms-fields.json 2 times'
    ]
  ])('refuses %s at the freeze', (text, message) => {
    expect(profileSiteManifestProblem(text, CMS, T, 'prod')).toContain(message);
  });
});
