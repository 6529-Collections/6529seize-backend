import fc from 'fast-check';
import {
  legacyCompetitionEntryId,
  legacyCompetitionId,
  stableUuid
} from '@/competitions/competition-id';

describe('competition stable identifiers', () => {
  it('implements RFC 4122 version 5 identifiers', () => {
    expect(
      stableUuid('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.widgets.com')
    ).toBe('21f7f8de-8051-5b89-8680-0195ef798b6a');
  });

  it('keeps every legacy wave mapping stable', () => {
    fc.assert(
      fc.property(fc.uuid(), (waveId) => {
        expect(legacyCompetitionId(waveId)).toBe(legacyCompetitionId(waveId));
      })
    );
  });

  it('namespaces entry identifiers by competition and drop', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), fc.uuid(), (competition, a, b) => {
        fc.pre(a !== b);
        expect(legacyCompetitionEntryId(competition, a)).not.toBe(
          legacyCompetitionEntryId(competition, b)
        );
      })
    );
  });
});
