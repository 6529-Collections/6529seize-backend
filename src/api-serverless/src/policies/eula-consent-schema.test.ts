import { EULAConsent } from '@/entities/IEULAPolicy';
import { getMetadataArgsStorage } from 'typeorm';

function columnOptions(propertyName: string) {
  return getMetadataArgsStorage().columns.find(
    (metadata) =>
      metadata.target === EULAConsent && metadata.propertyName === propertyName
  )?.options;
}

describe('EULA consent schema compatibility', () => {
  it('keeps legacy records representable as stale nullable versions', () => {
    expect(columnOptions('eula_version')).toEqual(
      expect.objectContaining({
        type: 'varchar',
        length: 32,
        nullable: true,
        default: null
      })
    );
  });

  it('adds the owner as a nullable column so existing rows stay valid', () => {
    expect(columnOptions('profile_id')).toEqual(
      expect.objectContaining({
        type: 'varchar',
        length: 100,
        nullable: true,
        default: null
      })
    );
  });
});
