import {
  artistCapabilities,
  canReadField,
  emptyCapabilities,
  mergeCapabilities,
  validateGrant
} from './artwork-documentation.access';
import { ContextAccess, ContextRecord } from './artwork-documentation.types';
import { emptyModules, getProfile } from './artwork-documentation.catalogue';

const context: ContextRecord = {
  id: 'c',
  work_id: 'w',
  owner_profile_id: 'artist',
  program_id: null,
  profile: getProfile('photography_documentation_v1', 1),
  draft_version: 1,
  artist_record_revision_id: null,
  latest_revision_id: null,
  lifecycle: 'active',
  modules: emptyModules(),
  asset_links: [],
  restricted_paths: ['context.caption'],
  created_at: 1,
  updated_at: 1
};
const access = (
  caps = emptyCapabilities(),
  isArtist = false
): ContextAccess => ({
  context,
  capabilities: caps,
  isArtist,
  actorProfileId: isArtist ? 'artist' : 'reviewer'
});
describe('artwork documentation authorization projection', () => {
  it('defaults old grants to no general restricted access and permits explicit artist delegation', () => {
    expect(
      mergeCapabilities([{ read_context: true }]).read_restricted_fields
    ).toBe(false);
    expect(artistCapabilities().read_restricted_fields).toBe(true);
    const delegated = validateGrant(
      { read_restricted_fields: true },
      access(artistCapabilities(), true)
    );
    expect(delegated.read_restricted_fields).toBe(true);
    expect(delegated.confirm_as_artist).toBe(false);
    expect(delegated.edit_modules).toEqual([]);
    expect(() =>
      validateGrant(
        { read_restricted_fields: true, review_lanes: ['curatorial'] },
        access({ ...emptyCapabilities(), manage_assignments: true })
      )
    ).toThrow(expect.objectContaining({ code: 'CANNOT_ELEVATE_GRANT' }));
    expect(
      validateGrant(
        { read_restricted_fields: true },
        access({ ...emptyCapabilities(), read_restricted_fields: true })
      ).read_restricted_fields
    ).toBe(true);
  });
  it.each([
    'identity.biography',
    'artwork.title',
    'context.caption',
    'interview.q1',
    'process.camera',
    'preservation.color_and_tone',
    'rights.publication_notes'
  ])(
    'reads explicitly authorized restricted current and historical %s',
    (path) => {
      const allowed = access({
        ...emptyCapabilities(),
        read_restricted_fields: true
      });
      expect(canReadField(allowed, path, true)).toBe(true);
      expect(
        canReadField(
          { ...allowed, context: { ...context, restricted_paths: [path] } },
          path
        )
      ).toBe(true);
      expect(canReadField(access(), path, true)).toBe(false);
    }
  );
  it('keeps contact, locked rights evidence and raw assets separately permissioned', () => {
    const general = access({
      ...emptyCapabilities(),
      read_restricted_fields: true
    });
    expect(canReadField(general, 'identity.private_contact', true)).toBe(false);
    expect(canReadField(general, 'rights.consent_asset_ids', true)).toBe(false);
    expect(general.capabilities.read_archival_files).toBe(false);
    expect(general.capabilities.read_source_receipts).toBe(false);
  });
  it('permits a coordinator to assign evidence to other reviewers without receiving that evidence', () => {
    const coordinator = access({
      ...emptyCapabilities(),
      manage_assignments: true,
      manage_context: true
    });
    expect(
      validateGrant(
        { review_lanes: ['rights'], read_rights_evidence: true },
        coordinator
      ).read_rights_evidence
    ).toBe(true);
    expect(
      validateGrant(
        { review_lanes: ['technical'], read_archival_files: true },
        coordinator
      ).read_archival_files
    ).toBe(true);
    expect(coordinator.capabilities.read_rights_evidence).toBe(false);
    expect(() =>
      validateGrant({ manage_context: true }, coordinator)
    ).toThrow();
  });
  it('never grants artist confirmation through grant data', () => {
    expect(
      mergeCapabilities([{ confirm_as_artist: true }]).confirm_as_artist
    ).toBe(false);
  });
  it('separates contact, rights and archival permissions', () => {
    const technical = access({
      ...emptyCapabilities(),
      read_archival_files: true
    });
    expect(canReadField(technical, 'rights.consent_status')).toBe(false);
    expect(canReadField(technical, 'identity.private_contact')).toBe(false);
    expect(canReadField(technical, 'process.camera', true)).toBe(true);
    expect(
      canReadField(
        access({ ...emptyCapabilities(), read_rights_evidence: true }),
        'rights.consent_asset_ids'
      )
    ).toBe(true);
  });
  it('narrowing a field also narrows historical disclosure', () => {
    expect(canReadField(access(), 'context.caption')).toBe(false);
    expect(
      canReadField(access(artistCapabilities(), true), 'context.caption')
    ).toBe(true);
  });
  it('keeps public-record ordinary answers private to already authorized context participants', () => {
    expect(canReadField(access(), 'artwork.title')).toBe(true);
    expect(emptyCapabilities().read_context).toBe(false);
  });
  it('does not let artists appoint reviewers or coordinators and prevents evidence elevation', () => {
    expect(() =>
      validateGrant(
        { review_lanes: ['rights'] },
        access(artistCapabilities(), true)
      )
    ).toThrow();
    expect(() =>
      validateGrant(
        { manage_assignments: true },
        access(artistCapabilities(), true)
      )
    ).toThrow();
    expect(() =>
      validateGrant(
        { read_rights_evidence: true },
        access({ ...emptyCapabilities(), manage_assignments: true })
      )
    ).toThrow();
    expect(
      validateGrant(
        { edit_modules: ['artwork'] },
        access(artistCapabilities(), true)
      ).edit_modules
    ).toEqual(['artwork']);
  });
});
