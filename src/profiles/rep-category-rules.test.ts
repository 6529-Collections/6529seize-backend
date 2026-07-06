import * as fc from 'fast-check';
import { REP_CATEGORY_PATTERN } from '@/entities/IAbusivenessDetectionResult';
import { explainRepCategoryViolation } from './rep-category-rules';

describe('explainRepCategoryViolation', () => {
  it('returns null for valid categories', () => {
    for (const text of [
      'Solidity Programming',
      'hey-jude',
      'state-of-the-art',
      "History of Carthage, vol. 1 (annotated)?!'",
      'Ω-木 mixed unicode'
    ]) {
      expect(explainRepCategoryViolation(text)).toBeNull();
    }
  });

  it('names the empty rule', () => {
    expect(explainRepCategoryViolation('')).toBe(`Category can't be empty.`);
  });

  it('names the length rule with the actual length', () => {
    expect(explainRepCategoryViolation('a'.repeat(101))).toBe(
      `Category is 101 characters long - the maximum is 100.`
    );
  });

  it('names the leading-dash rule', () => {
    expect(explainRepCategoryViolation('-Unreliable')).toBe(
      `Category can't start with a dash.`
    );
  });

  it('lists exactly which characters are disallowed, once each', () => {
    expect(explainRepCategoryViolation('web3:expert/artist:2')).toBe(
      `Category contains disallowed characters: ":", "/". Allowed characters are letters, numbers, spaces, dashes and , . ? ! ' ( ).`
    );
  });

  it('describes invisible characters by name', () => {
    expect(explainRepCategoryViolation('line\nbreak\ttab')).toBe(
      `Category contains disallowed characters: line break, tab. Allowed characters are letters, numbers, spaces, dashes and , . ? ! ' ( ).`
    );
  });

  it('reports the length rule before inspecting characters', () => {
    expect(explainRepCategoryViolation(`${'a'.repeat(101)}:`)).toContain(
      'characters long'
    );
  });

  it('agrees with REP_CATEGORY_PATTERN on every input (equivalence)', () => {
    // The explainer and the authoritative pattern must never disagree:
    // an input is valid exactly when there is no violation to explain.
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        const valid = REP_CATEGORY_PATTERN.test(text);
        const violation = explainRepCategoryViolation(text);
        return valid === (violation === null);
      })
    );
    fc.assert(
      fc.property(fc.fullUnicodeString({ maxLength: 120 }), (text) => {
        const valid = REP_CATEGORY_PATTERN.test(text);
        const violation = explainRepCategoryViolation(text);
        return valid === (violation === null);
      })
    );
  });
});
