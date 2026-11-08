import {
  CLIENT_VERSION_NONE,
  CLIENT_VERSION_OTHER,
  clientVersionFromQuery,
  recordClientVersionGauge,
  summarizeClientVersions
} from './ws-client-versions';

const sha = (n: number) => n.toString(16).padStart(7, '0');

describe('clientVersionFromQuery', () => {
  it.each([
    ['abc1234', 'abc1234'],
    ['ABC1234DEF', 'abc1234def'],
    [
      ' 0123456789abcdef0123456789abcdef01234567 ',
      '0123456789abcdef0123456789abcdef01234567'
    ]
  ])('accepts the hex SHA %p as %p', (value, expected) => {
    expect(clientVersionFromQuery({ client_version: value })).toBe(expected);
  });

  it.each([
    undefined,
    '',
    'abc123', // 6 chars
    '0123456789abcdef0123456789abcdef012345678', // 41 chars
    'abc123g',
    'v1.2.3',
    'abc1234; drop table x',
    '../../etc'
  ])('ignores %p', (value) => {
    expect(
      clientVersionFromQuery(
        value === undefined ? {} : { client_version: value }
      )
    ).toBeNull();
  });

  it('ignores a missing query', () => {
    expect(clientVersionFromQuery(null)).toBeNull();
    expect(clientVersionFromQuery(undefined)).toBeNull();
  });
});

describe('summarizeClientVersions', () => {
  it('keeps the top builds, sums the rest as other and undeclared as none', () => {
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => ({
        client_version: sha(i),
        sockets: String(100 - i)
      })),
      { client_version: null, sockets: 7 }
    ];

    const counts = summarizeClientVersions(rows, 20);

    expect(counts).toHaveLength(22);
    expect(counts.slice(0, 2)).toEqual([
      { version: sha(0), sockets: 100 },
      { version: sha(1), sockets: 99 }
    ]);
    // Builds 20..24 have 80..76 sockets.
    expect(counts[20]).toEqual({
      version: CLIENT_VERSION_OTHER,
      sockets: 80 + 79 + 78 + 77 + 76
    });
    expect(counts[21]).toEqual({ version: CLIENT_VERSION_NONE, sockets: 7 });
  });

  it('omits empty buckets', () => {
    expect(
      summarizeClientVersions([{ client_version: 'abc1234', sockets: 3 }])
    ).toEqual([{ version: 'abc1234', sockets: 3 }]);
    expect(summarizeClientVersions([])).toEqual([]);
  });

  it('never reports a stored value that is not a hex SHA', () => {
    expect(
      summarizeClientVersions([
        { client_version: 'not-a-sha', sockets: 2 },
        { client_version: 'abc1234', sockets: 1 }
      ])
    ).toEqual([
      { version: 'abc1234', sockets: 1 },
      { version: CLIENT_VERSION_NONE, sockets: 2 }
    ]);
  });
});

describe('recordClientVersionGauge', () => {
  it('writes one EMF line per build and one total, with no identifiers', async () => {
    const lines: string[] = [];
    const counts = await recordClientVersionGauge({
      db: {
        countPrimarySocketsByClientVersion: jest.fn().mockResolvedValue([
          { client_version: 'abc1234', sockets: 5 },
          { client_version: null, sockets: 2 }
        ])
      },
      write: (line) => lines.push(line),
      now: () => 1_000
    });

    expect(counts).toEqual([
      { version: 'abc1234', sockets: 5 },
      { version: CLIENT_VERSION_NONE, sockets: 2 }
    ]);
    const records = lines.map((line) => JSON.parse(line));
    expect(records).toEqual([
      expect.objectContaining({
        ClientVersion: 'abc1234',
        ConnectedSockets: 5
      }),
      expect.objectContaining({
        ClientVersion: CLIENT_VERSION_NONE,
        ConnectedSockets: 2
      }),
      expect.objectContaining({ ConnectedSockets: 7 })
    ]);
    expect(records[0]._aws).toEqual({
      Timestamp: 1_000,
      CloudWatchMetrics: [
        {
          Namespace: '6529/WebSocket',
          Dimensions: [['ClientVersion']],
          Metrics: [{ Name: 'ConnectedSockets', Unit: 'Count' }]
        }
      ]
    });
    expect(records[2]._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(
        record.ClientVersion === undefined
          ? ['ConnectedSockets', '_aws']
          : ['ClientVersion', 'ConnectedSockets', '_aws']
      );
    }
  });

  it('logs and returns null instead of throwing when the count fails', async () => {
    const write = jest.fn();
    await expect(
      recordClientVersionGauge({
        db: {
          countPrimarySocketsByClientVersion: jest
            .fn()
            .mockRejectedValue(new Error('db down'))
        },
        write
      })
    ).resolves.toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});
