import { Answer, Json } from '../../artwork-documentation.types';
import { dossierFixture } from './dossier-fixture';

/** Synthetic dimensional/geographic fixture for independent schema checks. */
export function lidoFixture() {
  const { snapshot } = dossierFixture();
  const id = (n: number) =>
    `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const provided = (value: Json): Answer => ({
    status: 'provided',
    intended_visibility: 'public_record',
    value
  });
  snapshot.context.modules.context.caption = provided({
    primary_language: 'en',
    versions: [
      {
        language: 'en',
        text: 'Caption in the original language.',
        authorship: 'original',
        approved_by_artist: true
      },
      {
        language: 'el',
        text: 'Το κατώφλι.',
        authorship: 'artist_translation',
        approved_by_artist: true
      }
    ]
  });
  snapshot.context.modules.artwork.measurements = provided([
    {
      id: id(20),
      subject_id: id(4),
      kind: 'width',
      scope: 'image',
      value: 120,
      unit: 'cm',
      precision: 'approximate'
    },
    {
      id: id(21),
      subject_id: id(4),
      kind: 'width',
      scope: 'sheet',
      value: 140,
      unit: 'cm'
    },
    {
      id: id(22),
      subject_id: id(3),
      kind: 'width',
      scope: 'digital_file',
      value: 6000,
      unit: 'px'
    }
  ]);
  snapshot.context.modules.artwork.places = provided([
    {
      id: id(23),
      name: 'Μήλος',
      language: 'el',
      role: 'depicted',
      certainty: 'uncertain',
      note: 'Artist-supplied location.',
      authorities: [
        {
          authority: 'TGN',
          identifier: '123',
          uri: 'http://vocab.getty.edu/tgn/123', // NOSONAR: Getty's canonical concept identifier, not a network request.
          label: 'Suggested place',
          match: 'suggested',
          evidence: 'Not reviewed.'
        }
      ]
    },
    { id: id(24), name: 'Studio', role: 'capture', certainty: 'known' }
  ]);
  snapshot.context.modules.context.events = provided([
    {
      id: id(25),
      kind: 'capture',
      title: 'Exposure',
      date: { start: '2026-05-18', precision: 'day', approximate: false },
      subject_ids: [id(2)],
      participants: [{ agent_id: id(6), role: 'photographer' }],
      place_id: id(24),
      account: 'The camera exposure was made in the studio.'
    },
    {
      id: id(26),
      kind: 'completion',
      title: 'Final image',
      date: { start: '2026-05', precision: 'month', approximate: true },
      subject_ids: [id(2)],
      participants: [{ agent_id: id(6), role: 'artist' }],
      account: 'The image was completed around May.'
    }
  ]);
  const documents = snapshot.context.modules.context.documents.value as Json[];
  documents.push({
    id: id(27),
    title: 'Machine transcript',
    kind: 'transcript',
    language: 'el',
    authors: [],
    authorship: 'machine_transcript',
    review_status: 'draft',
    text: 'Unreviewed machine words.'
  });
  return snapshot;
}
