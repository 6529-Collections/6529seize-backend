import {
  applyOperations,
  emptyModules,
  getProfile,
  conditionalRequired,
  FIELD_CATALOGUE
} from './artwork-documentation.catalogue';
import {
  answerValue,
  digest,
  matchesSchema,
  normalizeJson,
  parseIfMatch,
  validDate
} from './artwork-documentation.validation';
import { validateDocumentationRawJson } from './artwork-documentation.raw-json';
import { Answer, ModuleId } from './artwork-documentation.types';
import * as fc from 'fast-check';

const answer = (
  value: Answer['value'],
  intended_visibility: Answer['intended_visibility'] = 'public_record'
): Answer => ({ status: 'provided', value, intended_visibility });
const set = (module: ModuleId, field: string, value: Answer) =>
  applyOperations(module, {}, [{ op: 'set', field, answer: value }]);
describe('artwork documentation typed field contract', () => {
  it('registers exactly the eight modules and every configured required path', () => {
    for (const name of [
      'stream_artwork_basic_v1',
      'photography_documentation_v1',
      'keys_and_gates_v1'
    ]) {
      const profile = getProfile(name, 1);
      expect(profile.modules).toHaveLength(8);
      for (const path of profile.required_for_review) {
        const [module, field] = path.split('.') as [ModuleId, string];
        expect(FIELD_CATALOGUE[module].some((item) => item.id === field)).toBe(
          true
        );
      }
    }
  });
  it('normalizes Unicode and LF while preserving meaningful whitespace', () => {
    const result = set('artwork', 'title', answer('  Cafe\u0301\r\nImage  '));
    expect(answerValue(result.title)).toBe('  Café\nImage  ');
    expect(digest({ a: 'e\u0301\r\n' })).toBe(digest({ a: 'é\n' }));
  });
  it('rejects prototype keys, unknown paths, generated fields and malformed values', () => {
    for (const field of ['constructor', '__proto__', 'sha256', 'title.other'])
      expect(() => set('artwork', field, answer('x'))).toThrow();
    expect(() => set('artwork', 'title', answer(1))).toThrow();
    expect(() =>
      set('identity', 'private_contact', answer('contact'))
    ).toThrow();
    expect(() => set('artwork', 'title', answer(''))).toThrow();
  });
  it('withheld and unknown never retain a hidden value', () => {
    expect(
      set('artwork', 'location', {
        status: 'withheld',
        intended_visibility: 'public_record'
      }).location.status
    ).toBe('withheld');
    expect(() =>
      set('artwork', 'location', {
        status: 'withheld',
        value: 'secret',
        intended_visibility: 'restricted'
      })
    ).toThrow();
    expect(() =>
      set('rights', 'people_depicted', {
        status: 'unknown',
        intended_visibility: 'restricted'
      })
    ).toThrow();
  });
  it('permits truthful review-sensitive answers without claiming clearance', () => {
    expect(
      set('rights', 'people_depicted', answer('includes_minors', 'restricted'))
    ).toHaveProperty('people_depicted');
    expect(
      set(
        'files',
        'master_availability',
        answer({
          kind: 'unavailable',
          explanation: 'The original no longer survives.'
        })
      )
    ).toHaveProperty('master_availability');
  });
  it('validates real calendar dates and ordered ranges', () => {
    expect(validDate('2024-02-29')).toBe(true);
    expect(validDate('2023-02-29')).toBe(false);
    expect(() =>
      set(
        'artwork',
        'capture_date',
        answer({
          precision: 'range',
          endpoint_precision: 'year',
          start: '2025',
          end: '2024',
          approximate: false
        })
      )
    ).toThrow();
    expect(() =>
      set(
        'artwork',
        'capture_date',
        answer({ precision: 'month', start: '2024-02-29', approximate: false })
      )
    ).toThrow();
  });
  it('requires object details but permits missing conditional answers in drafts', () => {
    expect(() =>
      set('process', 'capture_method', answer({ kind: 'other' }))
    ).toThrow();
    expect(() =>
      set('process', 'ai_use', answer({ kind: 'generative' }))
    ).toThrow();
    const modules = emptyModules();
    modules.process = set(
      'process',
      'techniques',
      answer({ kinds: ['composite', 'miniature'] })
    );
    expect(conditionalRequired(modules)).toEqual([
      'process.ingredients',
      'process.construction_note'
    ]);
  });
  it('retains untouched module fields when a partial operation is applied', () => {
    const previous = { title: answer('Title'), location: answer('Place') };
    expect(
      applyOperations('artwork', previous, [{ op: 'unset', field: 'title' }])
    ).toEqual({ location: previous.location });
    expect(previous.title.value).toBe('Title');
  });
  it('uses code point limits, rejects lone surrogates and cannot silently coerce strings', () => {
    expect(set('artwork', 'title', answer('😀'.repeat(255)))).toHaveProperty(
      'title'
    );
    expect(() => set('artwork', 'title', answer('😀'.repeat(256)))).toThrow();
    expect(() => normalizeJson('\ud800')).toThrow();
    expect(matchesSchema('12', { type: 'integer' })).toBe(false);
  });
  it('rejects duplicate JSON keys including escaped key spellings before parsing', () => {
    expect(() =>
      validateDocumentationRawJson(Buffer.from('{"title":1,"\\u0074itle":2}'))
    ).toThrow();
    expect(() =>
      validateDocumentationRawJson(Buffer.from('{"a":{"x":1},"b":{"x":2}}'))
    ).not.toThrow();
  });
  it('requires exact draft ETags', () => {
    expect(parseIfMatch('"draft-12"')).toBe(12);
    for (const input of [
      undefined,
      '*',
      'draft-12',
      '"draft-0"',
      'W/"draft-12"'
    ])
      expect(() => parseIfMatch(input)).toThrow();
  });
  it('canonical digest is independent of object insertion order', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer(), (title, version) => {
        expect(digest({ title, version })).toBe(digest({ version, title }));
      })
    );
  });
});
