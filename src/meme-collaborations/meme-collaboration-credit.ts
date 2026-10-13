import { MemeCollaborationCredit } from '@/entities/IMemeCollaboration';

export function collaborationMetadataValues(
  credit: MemeCollaborationCredit
): ReadonlyMap<string, string> {
  return new Map([
    ['artist', credit.artist],
    ['seizeArtistProfile', credit.artist_profiles],
    ['collab', String(credit.collab)]
  ]);
}

export function withCollaborationCredit<
  T extends { trait_type: string; value: string | number }
>(
  attributes: T[],
  credit: MemeCollaborationCredit
): Array<T | { trait_type: string; value: string }> {
  return [
    ...attributes.filter(
      (item) =>
        !['artist', 'seize artist profile', 'collab'].includes(
          item.trait_type.trim().toLowerCase()
        )
    ),
    { trait_type: 'Artist', value: credit.artist },
    { trait_type: 'SEIZE Artist Profile', value: credit.artist_profiles },
    { trait_type: 'Collab', value: credit.collab ? 'Yes' : 'No' }
  ];
}
