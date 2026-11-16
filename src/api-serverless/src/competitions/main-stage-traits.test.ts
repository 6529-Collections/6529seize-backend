import { CompetitionCapability } from '@/entities/ICompetition';
import {
  checkMainStageTraits,
  mainStageTraitRules,
  normalizeMainStageTraits
} from './main-stage-traits';

const capabilities = [CompetitionCapability.MAIN_STAGE];

function metadata(values: Record<string, string>) {
  return Object.entries(values).map(([data_key, data_value]) => ({
    data_key,
    data_value
  }));
}

const validTraits = {
  title: 'Title',
  description: 'Description',
  artist: 'Artist',
  memeName: 'GM',
  palette: 'Color',
  pointsPower: '0.5',
  pointsWisdom: '-2',
  pointsLoki: '1',
  pointsSpeed: '1e-7'
};

beforeEach(() => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    MAIN_STAGE_TRAIT_VALIDATION_ENABLED: 'true'
  });
});
afterEach(() => jest.restoreAllMocks());

it('preserves explicit metadata and only defaults omitted skippable fields', () => {
  const supplied = metadata({
    ...validTraits,
    food: 'Pie',
    pepe: 'true',
    custom: 'Value'
  });
  const normalized = normalizeMainStageTraits(supplied, capabilities);
  expect(normalized.slice(0, supplied.length)).toEqual(supplied);
  expect(normalized.slice(supplied.length)).toEqual(
    expect.arrayContaining([
      { data_key: 'bonus', data_value: 'No' },
      { data_key: 'gm', data_value: 'false' }
    ])
  );
  expect(normalized.filter((item) => item.data_key === 'food')).toEqual([
    { data_key: 'food', data_value: 'Pie' }
  ]);
});

it('identifies missing, invalid and duplicate traits before a signed write', () => {
  const input = metadata({
    ...validTraits,
    palette: 'No',
    pointsSpeed: '0',
    pepe: 'maybe'
  });
  input.push({ data_key: 'artist', data_value: 'Another name' });
  const rules = mainStageTraitRules(capabilities)!;
  expect(
    checkMainStageTraits(
      input.filter((item) => item.data_key !== 'title'),
      rules
    ).issues
  ).toEqual([
    { key: 'title', code: 'REQUIRED' },
    { key: 'artist', code: 'DUPLICATE' },
    { key: 'pointsSpeed', code: 'INVALID_POINTS' },
    { key: 'pepe', code: 'INVALID_BOOLEAN' },
    { key: 'palette', code: 'INVALID_CHOICE' }
  ]);
  expect(() => normalizeMainStageTraits(input, capabilities)).toThrow(
    'palette (INVALID_CHOICE)'
  );
});

it('preserves existing requests for other decisions and when enforcement is disabled', () => {
  const supplied = metadata({ pointsSpeed: '0' });
  expect(normalizeMainStageTraits(supplied, [])).toBe(supplied);
  jest.replaceProperty(process, 'env', {
    ...process.env,
    MAIN_STAGE_TRAIT_VALIDATION_ENABLED: undefined,
    NODE_ENV: 'production',
    API_BASE_URL: 'https://api.6529.io'
  });
  expect(normalizeMainStageTraits(supplied, capabilities)).toBe(supplied);
  jest.replaceProperty(process, 'env', {
    ...process.env,
    NODE_ENV: 'development'
  });
  expect(normalizeMainStageTraits(supplied, capabilities)).toBe(supplied);
  jest.replaceProperty(process, 'env', {
    ...process.env,
    API_BASE_URL: 'https://api.staging.6529.io/api'
  });
  expect(mainStageTraitRules(capabilities)).toBeDefined();
  jest.replaceProperty(process, 'env', {
    ...process.env,
    MAIN_STAGE_TRAIT_VALIDATION_ENABLED: 'false'
  });
  expect(normalizeMainStageTraits(supplied, capabilities)).toBe(supplied);
});

it('uses inclusive decimal point bounds and rejects nondecimal representations', () => {
  const rules = mainStageTraitRules(capabilities)!;
  expect(
    checkMainStageTraits(
      metadata({ ...validTraits, pointsSpeed: '-1e10' }),
      rules
    ).issues
  ).toEqual([]);
  expect(
    checkMainStageTraits(
      metadata({ ...validTraits, pointsSpeed: '1e10' }),
      rules
    ).issues
  ).toEqual([]);
  for (const pointsSpeed of [
    '10000000001',
    '-10000000001',
    '0x10',
    'Infinity'
  ]) {
    expect(
      checkMainStageTraits(metadata({ ...validTraits, pointsSpeed }), rules)
        .issues
    ).toEqual([{ key: 'pointsSpeed', code: 'INVALID_POINTS' }]);
  }
});
