import { EULAConsent } from '@/entities/IEULAPolicy';
import { getMetadataArgsStorage } from 'typeorm';

describe('EULA consent schema compatibility', () => {
  it('keeps legacy records representable as stale nullable versions', () => {
    const versionColumn = getMetadataArgsStorage().columns.find(
      (metadata) =>
        metadata.target === EULAConsent &&
        metadata.propertyName === 'eula_version'
    );

    expect(versionColumn?.options).toEqual(
      expect.objectContaining({
        type: 'varchar',
        length: 32,
        nullable: true,
        default: null
      })
    );
  });
});
