import { parseMigrationChangeImage } from './competition-migration-journal';

describe('migration journal images', () => {
  it('accepts object/string driver representations and absent before-images', () => {
    const row = { drop_id: 'entry', votes: 3 };
    expect(parseMigrationChangeImage(row)).toBe(row);
    expect(parseMigrationChangeImage(JSON.stringify(row))).toEqual(row);
    expect(parseMigrationChangeImage(null)).toBeNull();
  });
  it.each(['{private malformed payload', '[]', '1', undefined])(
    'classifies a corrupt image as an owned stop without leaking it',
    (image) => {
      expect(() => parseMigrationChangeImage(image)).toThrow('OWNED_EXCEPTION');
      expect(() => parseMigrationChangeImage(image)).not.toThrow('private');
    }
  );
});
