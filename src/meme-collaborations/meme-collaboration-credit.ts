import { MemeCollaborationCredit } from '@/entities/IMemeCollaboration';
import { BadRequestException } from '@/exceptions';

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

export function assertCollaborationCredit(
  attributes: unknown,
  credit: MemeCollaborationCredit
): void {
  if (!Array.isArray(attributes))
    throw new BadRequestException('Missing approved artist credits');
  for (const [label, expected] of [
    ['Artist', credit.artist],
    ['SEIZE Artist Profile', credit.artist_profiles],
    ['Collab', credit.collab ? 'Yes' : 'No']
  ]) {
    const matches = attributes.filter(
      (item) =>
        item &&
        typeof item.trait_type === 'string' &&
        item.trait_type.trim().toLowerCase() === label.toLowerCase()
    );
    if (matches.length !== 1 || String(matches[0].value).trim() !== expected)
      throw new BadRequestException(
        'Artist credits are fixed by the accepted collaborators at mint selection'
      );
  }
}
