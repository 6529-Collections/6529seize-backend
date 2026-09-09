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
