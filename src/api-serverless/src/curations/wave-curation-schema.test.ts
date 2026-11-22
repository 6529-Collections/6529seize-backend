import { WaveCurationSchema } from './wave-curation.schema';

describe('WaveCurationSchema', () => {
  const group = {
    tdh: { min: 100, inclusion_strategy: 'TDH' },
    rep: {},
    cic: {},
    level: {},
    owns_nfts: [],
    identity_addresses: null,
    excluded_identity_addresses: null
  };

  it('requires an explicit privacy choice for inline criteria', () => {
    expect(
      WaveCurationSchema.validate({ name: 'Picks', criteria: { group } }).error
        ?.details[0].path
    ).toEqual(['criteria', 'is_private']);
    for (const is_private of [true, false]) {
      expect(
        WaveCurationSchema.validate({
          name: 'Picks',
          criteria: { group, is_private }
        }).error
      ).toBeUndefined();
    }
  });

  it('rejects incomplete criteria and unsupported TDH strategies', () => {
    const validateGroup = (draft: unknown) =>
      WaveCurationSchema.validate({
        name: 'Picks',
        criteria: { group: draft, is_private: true }
      }).error?.details[0].path;
    expect(validateGroup({ ...group, level: undefined })).toEqual([
      'criteria',
      'group',
      'level'
    ]);
    expect(
      validateGroup({
        ...group,
        tdh: { ...group.tdh, inclusion_strategy: 'unknown' }
      })
    ).toEqual(['criteria', 'group', 'tdh', 'inclusion_strategy']);
  });

  it('accepts a legacy group ID and rejects requests with both sources', () => {
    const legacy = { name: 'Picks', group_id: 'curators' };
    expect(WaveCurationSchema.validate(legacy).error).toBeUndefined();
    expect(
      WaveCurationSchema.validate({
        ...legacy,
        criteria: { group, is_private: true }
      }).error?.details[0].type
    ).toBe('object.xor');
  });
});
