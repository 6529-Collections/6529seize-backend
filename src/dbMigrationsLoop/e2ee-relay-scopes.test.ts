import {
  parseE2eeRelayBackfillRequest,
  runE2eeRelayBackfillScope,
  runE2eeRelayPublishScope,
  runE2eeRelayRebuildScope
} from './e2ee-relay-scopes';

describe('e2ee relay operator scopes', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('parses a backfill request, dry run by default', () => {
    expect(parseE2eeRelayBackfillRequest({ family: 'cv' })).toEqual({
      live: false,
      family: 'cv',
      after: undefined,
      limit: 200
    });
    expect(
      parseE2eeRelayBackfillRequest({
        family: 'bk',
        live: true,
        after: '0xab',
        limit: 5
      })
    ).toEqual({ live: true, family: 'bk', after: '0xab', limit: 5 });
  });

  it('refuses a request it cannot run as written', () => {
    expect(() => parseE2eeRelayBackfillRequest({})).toThrow('family');
    expect(() => parseE2eeRelayBackfillRequest({ family: 'ps' })).toThrow(
      'family'
    );
    expect(() =>
      parseE2eeRelayBackfillRequest({ family: 'cv', live: 'yes' })
    ).toThrow('live');
    expect(() =>
      parseE2eeRelayBackfillRequest({ family: 'cv', limit: 0 })
    ).toThrow('limit');
    expect(() =>
      parseE2eeRelayBackfillRequest({ family: 'cv', after: 7 })
    ).toThrow('after');
  });

  it('copies nothing live while records are off', async () => {
    delete process.env.E2EE_RELAY_MODE;
    await expect(
      runE2eeRelayBackfillScope({ family: 'cv', live: true })
    ).rejects.toThrow('E2EE_RELAY_MODE');
  });

  it('checks the publish and rebuild arguments first', async () => {
    await expect(runE2eeRelayPublishScope({ waves: 0 })).rejects.toThrow(
      'waves'
    );
    await expect(runE2eeRelayRebuildScope({ mode: 'fix' })).rejects.toThrow(
      'mode'
    );
  });
});
