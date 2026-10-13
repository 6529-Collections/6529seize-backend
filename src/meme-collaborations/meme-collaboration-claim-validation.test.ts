import type { MemeCollaborationEntity } from '@/entities/IMemeCollaboration';
import { withCollaborationCredit } from './meme-collaboration-credit';
import {
  assertCollaborationClaimPatch,
  assertCollaborationClaimPublication
} from './meme-collaboration-claim-validation';

const collaboration: MemeCollaborationEntity = {
  drop_id: 'drop',
  author_id: 'A',
  author_handle: 'A',
  wave_id: 'wave',
  artwork_hash: 'a'.repeat(64),
  base_artist: 'A',
  terms: null,
  terms_version: 'b'.repeat(64),
  closed_at: 1,
  artwork: {
    name: 'Artwork',
    description: 'Description',
    image_url: 'https://media.example/art.png',
    animation_url: null
  },
  credit: { artist: 'A, B', artist_profiles: 'A, B', collab: true }
};
const attributes = withCollaborationCredit([], collaboration.credit!);

it.each(['name', 'description', 'image_url', 'animation_url'] as const)(
  'rejects changed accepted %s in both patch and publication',
  (field) => {
    const replacement = { [field]: 'replacement' };
    expect(() =>
      assertCollaborationClaimPatch(replacement, collaboration)
    ).toThrow('locks the artwork');
    expect(() =>
      assertCollaborationClaimPublication(
        { ...collaboration.artwork, ...replacement },
        attributes,
        collaboration
      )
    ).toThrow('differs from accepted');
  }
);

it('permits omitted/unchanged fields but requires the frozen snapshot and approved credits for publication', () => {
  expect(() => assertCollaborationClaimPatch({}, collaboration)).not.toThrow();
  expect(() =>
    assertCollaborationClaimPatch(
      { ...collaboration.artwork, attributes },
      collaboration
    )
  ).not.toThrow();
  expect(() =>
    assertCollaborationClaimPublication(
      collaboration.artwork,
      attributes,
      collaboration
    )
  ).not.toThrow();
  expect(() =>
    assertCollaborationClaimPublication(collaboration.artwork, attributes, {
      ...collaboration,
      credit: null
    })
  ).toThrow('Missing accepted-artist snapshot');
  expect(() =>
    assertCollaborationClaimPatch({ attributes: [] }, collaboration)
  ).toThrow('fixed');
  expect(() =>
    assertCollaborationClaimPublication(
      collaboration.artwork,
      [],
      collaboration
    )
  ).toThrow('fixed');
});

it('retains unmanaged behavior and allows single-artist media edits while preserving managed credits', () => {
  expect(() =>
    assertCollaborationClaimPatch({ name: 'Replacement' }, null)
  ).not.toThrow();
  expect(() => assertCollaborationClaimPublication({}, [], null)).not.toThrow();
  const singleArtist = {
    ...collaboration,
    credit: { artist: 'A', artist_profiles: 'A', collab: false }
  };
  const approved = withCollaborationCredit([], singleArtist.credit);
  expect(() =>
    assertCollaborationClaimPatch(
      { name: 'Replacement', attributes: approved },
      singleArtist
    )
  ).not.toThrow();
  expect(() =>
    assertCollaborationClaimPublication({}, approved, singleArtist)
  ).not.toThrow();
  expect(() =>
    assertCollaborationClaimPatch({ attributes: [] }, singleArtist)
  ).toThrow('fixed');
});
