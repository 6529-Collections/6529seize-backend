import { ProfileClassification } from '@/entities/IProfile';
import {
  resolveSubClassification,
  sub_classification_to_classification
} from './profile.helper';

describe('resolveSubClassification', () => {
  it.each(Object.values(ProfileClassification))(
    'drops an unknown sub-classification for %s',
    (classification) => {
      expect(resolveSubClassification('Not A Thing', classification)).toBe(
        null
      );
      expect(resolveSubClassification('toString', classification)).toBe(null);
      expect(resolveSubClassification('__proto__', classification)).toBe(null);
    }
  );

  it.each([null, undefined])(
    'keeps an absent sub-classification absent',
    (sub) => {
      expect(
        resolveSubClassification(sub, ProfileClassification.PSEUDONYM)
      ).toBe(null);
    }
  );

  const pairs = Object.entries(sub_classification_to_classification).flatMap(
    ([sub, classifications]) =>
      Object.values(ProfileClassification).map(
        (classification) =>
          [
            sub,
            classification,
            classifications.includes(classification)
          ] as const
      )
  );

  it.each(pairs)(
    'resolves %s for %s (allowed: %s)',
    (sub, classification, allowed) => {
      expect(resolveSubClassification(sub, classification)).toBe(
        allowed ? sub : null
      );
    }
  );

  it('keeps Other for both of its classifications', () => {
    expect(
      resolveSubClassification('Other', ProfileClassification.COLLECTION)
    ).toBe('Other');
    expect(
      resolveSubClassification('Other', ProfileClassification.ORGANIZATION)
    ).toBe('Other');
    expect(
      resolveSubClassification('Other', ProfileClassification.PSEUDONYM)
    ).toBe(null);
  });
});
