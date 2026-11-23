import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AreaManifest } from '@/rebuild/manifest.types';
import {
  startCrpRelay,
  startCrpRelayReplay
} from '@/rebuild/sources/crp-relay';
import { captureRelay } from '@/rebuild/sources/crp-relay-capture';
import { startCrpRelayRecord } from '@/rebuild/sources/crp-relay-record';
import {
  checkFor,
  guardedVerifier,
  inProcessVerifier,
  LoadedRelayCheck,
  relayCheckSpecs,
  verifyRelayItems
} from '@/rebuild/sources/relay-checks';
import { checkSignedEvent } from '@/rebuild/sources/relay-event-check';
import { signedEvent } from '@/rebuild/sources/relay-fixture';
import {
  readProvenance,
  writeProvenance
} from '@/rebuild/sources/running-source';

const WebSocketClient = require('ws') as new (url: string) => {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: Buffer, binary: boolean) => void): void;
  send(data: string | Buffer): void;
  close(): void;
};

type Frame = Record<string, unknown>;

const READER = '0x00000000000000000000000000000000000000ab';

/** A CRP client that keeps every text frame it gets; AUTH as `wallet`. */
async function connect(
  url: string,
  wallet: string | null = READER,
  grant: Record<string, unknown> = {}
) {
  const socket = new WebSocketClient(url);
  const frames: Frame[] = [];
  socket.on('message', (data, binary) => {
    if (!binary) frames.push(JSON.parse(data.toString()));
  });
  await new Promise<void>((resolve) => socket.on('open', resolve));
  const waitFor = (match: (frame: Frame) => boolean) =>
    new Promise<Frame>((resolve) => {
      const poll = () => {
        const found = frames.find(match);
        if (found) resolve(found);
        else setTimeout(poll, 10);
      };
      poll();
    });
  const send = (frame: Frame) => socket.send(JSON.stringify(frame));
  const sendBinary = (header: Frame, bytes: Buffer) => {
    const head = Buffer.from(JSON.stringify(header), 'utf8');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(head.length, 0);
    socket.send(Buffer.concat([prefix, head, bytes]));
  };
  send({ t: 'HELLO', v: 1, net: 'test-net' });
  await waitFor((f) => f.t === 'CHALLENGE');
  if (wallet) {
    send({ t: 'AUTH', rid: 0, grant: { wallet, ...grant }, sig: '0x' });
    await waitFor((f) => f.t === 'AUTHED');
  }
  return { frames, waitFor, send, sendBinary, close: () => socket.close() };
}

const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

const PAYLOAD = Buffer.from('payload');
const GOOD = signedEvent({ wave: 'dr/0xaa', body: { h: sha256(PAYLOAD) } });
const GRANT = { wallet: READER };

/** An area's check that refuses events whose refs say `refused`. */
const areaCheck = (waves: string[]): LoadedRelayCheck => ({
  area: 'test',
  waves,
  check: (item) =>
    ((item.event.refs as string[] | undefined) ?? []).includes('refused')
      ? { ok: false, reason: 'not the orderer' }
      : { ok: true }
});

const replayOf = (dirs: string[], checks: LoadedRelayCheck[], root: string) =>
  startCrpRelayReplay(
    dirs,
    inProcessVerifier(checks),
    path.join(root, 'merged')
  );

describe('relay recordings', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-relay-rec-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /** Records one session through the proxy: a publish, a payload, reads. */
  async function record(dir = path.join(root, 'recording')): Promise<string> {
    const upstream = await startCrpRelay(path.join(root, 'upstream'));
    const recorder = await startCrpRelayRecord({
      dir,
      upstream: upstream.url,
      upstreamLabel: 'the harness relay'
    });
    const client = await connect(recorder.url);
    client.sendBinary(
      { t: 'PAYLOAD_PUT', rid: 1, sha256: sha256(PAYLOAD) },
      PAYLOAD
    );
    await client.waitFor((f) => f.t === 'ACK' && f.rid === 1);
    client.send({ t: 'PUB', rid: 2, event: GOOD, grant: GRANT });
    await client.waitFor((f) => f.t === 'ACK' && f.rid === 2);
    client.send({
      t: 'SUB',
      sid: 7,
      waves: ['*'],
      from_start: true,
      since: []
    });
    await client.waitFor((f) => f.t === 'EOSE' && f.sid === 7);
    client.send({ t: 'HIST', rid: 3, wave: 'dr/0xaa', after: null, limit: 10 });
    await client.waitFor((f) => f.t === 'RES' && f.rid === 3);
    client.close();
    await recorder.stop();
    await upstream.stop();
    expect(recorder.problems()).toEqual([]);
    return dir;
  }

  it('records what a run reads and publishes, with no address in the files', async () => {
    const dir = await record();
    const [stored] = fs
      .readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(stored).toMatchObject({
      rseq: 1,
      event: { id: GOOD.id, wave: 'dr/0xaa' },
      grant: GRANT,
      extra: { receipts: [] }
    });
    expect(typeof stored.recorded_at).toBe('number');
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, 'reads.json'), 'utf8'))
    ).toEqual(['*', 'dr/0xaa']);
    expect(fs.readdirSync(path.join(dir, 'payloads'))).toEqual([
      sha256(PAYLOAD)
    ]);
    expect(readProvenance(dir)).toMatchObject({
      made_by: 'record of the harness relay',
      recorded_at: expect.any(String)
    });
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toMatch(
        /127\.0\.0\.1|ws:\/\//
      );
    }
  });

  it('writes PROVENANCE.json afresh, so no label outlives a recording', async () => {
    const dir = path.join(root, 'recording');
    writeProvenance(dir, {
      made_by: 'an earlier devnet capture',
      devnet_scenario: 'old'
    } as never);
    await record(dir);
    expect(readProvenance(dir)).toEqual({
      made_by: 'record of the harness relay',
      recorded_at: expect.any(String)
    });
  });

  it('counts a recording for a final run when every event passes both checks', async () => {
    const dir = await record();
    const replay = await replayOf([dir], [areaCheck(['dr/'])], root);
    try {
      expect(replay.info).toMatchObject({ mode: 'replay', provisional: false });
      expect(replay.info.provenance).toBe(
        "record of the harness relay (final; 1 of 1 events pass the signed-event check and their area's)"
      );
      const client = await connect(replay.url);
      // A seed publishing the recorded event again, under its grant: a duplicate.
      client.send({ t: 'PUB', rid: 2, event: GOOD, grant: GRANT });
      expect(
        await client.waitFor((f) => f.t === 'ACK' && f.rid === 2)
      ).toMatchObject({ status: 'duplicate' });
      client.send({
        t: 'SUB',
        sid: 1,
        waves: ['*'],
        from_start: true,
        since: []
      });
      const ev = await client.waitFor((f) => f.t === 'EV' && f.sid === 1);
      expect(ev).toMatchObject({ rseq: 1, receipts: [] });
      expect(typeof ev.recorded_at).toBe('number');
      client.close();
      expect(replay.problems()).toEqual([]);
    } finally {
      await replay.stop();
    }
  });

  it('fails a run that publishes or reads what the recording does not hold', async () => {
    const dir = await record();
    fs.writeFileSync(path.join(dir, 'reads.json'), JSON.stringify(['dr/0xaa']));
    const replay = await replayOf([dir], [areaCheck(['dr/'])], root);
    try {
      const client = await connect(replay.url);
      const other = signedEvent({ wave: 'dr/0xaa', seq: 2 });
      client.send({ t: 'PUB', rid: 2, event: other, grant: GRANT });
      expect(
        await client.waitFor((f) => f.t === 'ACK' && f.rid === 2)
      ).toMatchObject({ status: 'rejected', reason: 'not in the recording' });
      // The recorded event under another grant: not the recorded publish.
      client.send({ t: 'PUB', rid: 3, event: GOOD, grant: { wallet: '0x01' } });
      expect(
        await client.waitFor((f) => f.t === 'ACK' && f.rid === 3)
      ).toMatchObject({ reason: 'differs from the recording' });
      client.send({
        t: 'HIST',
        rid: 4,
        wave: 'cv/0xbb',
        after: null,
        limit: 10
      });
      await client.waitFor((f) => f.t === 'RES' && f.rid === 4);
      const fresh = Buffer.from('new');
      client.sendBinary(
        { t: 'PAYLOAD_PUT', rid: 5, sha256: sha256(fresh) },
        fresh
      );
      await client.waitFor((f) => f.t === 'ACK' && f.rid === 5);
      client.close();
      expect(replay.problems()).toEqual([
        `relays: 2 published events the recording does not hold, first ${other.id} in dr/0xaa (not in the recording)`,
        'relays: 1 reads of waves the recorded run never read, first cv/0xbb',
        `relays: 1 payloads put that the recording does not hold, first ${sha256(fresh)}`
      ]);
    } finally {
      await replay.stop();
    }
  });

  it('never counts a recording on its label: forged, unchecked or empty stays provisional', async () => {
    const dir = await record();
    // A devnet label and no area's check: provisional.
    writeProvenance(dir, {
      made_by: 'devnet capture',
      devnet_scenario: 'any'
    } as never);
    const unchecked = await replayOf([dir], [], root);
    expect(unchecked.info.provisional).toBe(true);
    expect(unchecked.info.provenance).toBe(
      "devnet capture, devnet scenario any (provisional; 0 of 1 events pass the signed-event check and their area's, 1 in waves no area's check covers (dr/0xaa))"
    );
    expect(unchecked.problems()).toEqual([]);
    await unchecked.stop();
    // A forged event (made-up id and signature) under the same label fails.
    const events = path.join(dir, 'events.jsonl');
    const forged = {
      ...GOOD,
      id: `0x${'ab'.repeat(32)}`,
      signature: '0xdeadbeef'
    };
    fs.writeFileSync(
      events,
      `${JSON.stringify({ rseq: 1, event: forged, grant: GRANT })}\n`
    );
    const [name] = fs.readdirSync(path.join(dir, 'payloads'));
    fs.writeFileSync(path.join(dir, 'payloads', name), 'tampered');
    const replay = await replayOf([dir], [areaCheck(['dr/'])], root);
    expect(replay.info.provisional).toBe(true);
    expect(replay.problems()).toEqual([
      `relays: 1 recorded events that fail their checks, first ${forged.id} in dr/0xaa: signed event: the id is not the digest of its fields`,
      `relays: 1 recorded payloads that don't match their hash, first ${name}`
    ]);
    await replay.stop();
    // An event the area's check refuses.
    const refused = signedEvent({ wave: 'dr/0xaa', refs: ['refused'] });
    fs.writeFileSync(
      events,
      `${JSON.stringify({ rseq: 1, event: refused, grant: GRANT })}\n`
    );
    const byArea = await replayOf([dir], [areaCheck(['dr/'])], root);
    expect(byArea.problems()[0]).toBe(
      `relays: 1 recorded events that fail their checks, first ${refused.id} in dr/0xaa: test: not the orderer`
    );
    await byArea.stop();
    // No events at all.
    fs.writeFileSync(events, '');
    const empty = await replayOf([dir], [areaCheck(['dr/'])], root);
    expect(empty.info.provisional).toBe(true);
    await empty.stop();
  });

  it('judges merged recordings each on its own', async () => {
    const dir = await record();
    const other = path.join(root, 'other');
    fs.mkdirSync(path.join(other, 'payloads'), { recursive: true });
    const second = signedEvent({ wave: 'cv/0xbb' });
    fs.writeFileSync(
      path.join(other, 'events.jsonl'),
      `${JSON.stringify({ rseq: 1, event: second, grant: GRANT })}\n`
    );
    fs.writeFileSync(
      path.join(other, 'reads.json'),
      JSON.stringify(['cv/0xbb'])
    );
    const merged = await replayOf(
      [dir, other],
      [areaCheck(['dr/', 'cv/'])],
      root
    );
    try {
      expect(merged.info.provisional).toBe(false);
      expect(merged.info.provenance).toContain(' + no made_by (final; 1 of 1');
      const client = await connect(merged.url);
      client.send({
        t: 'SUB',
        sid: 1,
        waves: ['*'],
        from_start: true,
        since: []
      });
      await client.waitFor(
        (f) => f.t === 'EOSE' && f.sid === 1 && f.wave === 'cv'
      );
      expect(
        client.frames
          .filter((f) => f.t === 'EV')
          .map((f) => [f.wave, f.rseq, (f.event as { id: string }).id])
      ).toEqual([
        ['dr', 1, GOOD.id],
        ['cv', 1, second.id]
      ]);
      client.close();
      expect(merged.problems()).toEqual([]);
    } finally {
      await merged.stop();
    }
  });

  it('captures a whole relay into a recording a replay serves', async () => {
    const relay = await startCrpRelay(path.join(root, 'relay'));
    try {
      const client = await connect(relay.url);
      client.sendBinary(
        { t: 'PAYLOAD_PUT', rid: 1, sha256: sha256(PAYLOAD) },
        PAYLOAD
      );
      await client.waitFor((f) => f.t === 'ACK' && f.rid === 1);
      const events = [
        signedEvent({ wave: 'w1', kind: 1, seq: 1 }),
        GOOD,
        signedEvent({ wave: 'w1', kind: 1, seq: 2 })
      ];
      for (let i = 0; i < events.length; i++) {
        client.send({ t: 'PUB', rid: i + 2, event: events[i], grant: GRANT });
        await client.waitFor((f) => f.t === 'ACK' && f.rid === i + 2);
      }
      client.close();
      const dir = path.join(root, 'captured');
      const result = await captureRelay({
        url: relay.url,
        dir,
        net: 'test-net',
        madeBy: 'a capture of the harness relay',
        devnetScenario: 'relay-world',
        harnessWallet: READER,
        quietMs: 300
      });
      expect(result).toEqual({ events: 3, logs: ['w1', 'dr'], payloads: 1 });
      expect(readProvenance(dir)).toMatchObject({
        made_by: 'a capture of the harness relay',
        devnet_scenario: 'relay-world'
      });
      const replay = await replayOf([dir], [areaCheck(['w', 'dr/'])], root);
      try {
        expect(replay.info.provisional).toBe(false);
        const reader = await connect(replay.url);
        reader.send({ t: 'HIST', rid: 5, wave: 'w1', after: 0, limit: 10 });
        const res = await reader.waitFor((f) => f.t === 'RES' && f.rid === 5);
        expect((res.items as { rseq: number }[]).map((i) => i.rseq)).toEqual([
          1, 2
        ]);
        reader.close();
        expect(replay.problems()).toEqual([]);
      } finally {
        await replay.stop();
      }
    } finally {
      await relay.stop();
    }
  });

  it('logs each wave (a family by its code) with its own rseq, as the relays do', async () => {
    const relay = await startCrpRelay(path.join(root, 'relay'));
    try {
      const client = await connect(relay.url);
      for (const [rid, id, wave] of [
        [1, 'a', 'w1'],
        [2, 'b', 'dv/0x1'],
        [3, 'c', 'w1'],
        [4, 'd', 'dv/0x2'],
        [5, 'e', 'w2']
      ] as const) {
        client.send({
          t: 'PUB',
          rid,
          event: { id, wave, kind: 9, body: null },
          grant: {}
        });
        await client.waitFor((f) => f.t === 'ACK' && f.rid === rid);
      }
      // Every log from the start, w1 after its cursor of this epoch; a
      // cursor of another epoch is no cursor.
      client.send({
        t: 'SUB',
        sid: 9,
        waves: ['*'],
        from_start: true,
        since: [
          { wave: 'w1', log_epoch: 1, rseq: 1 },
          { wave: 'w2', log_epoch: 7, rseq: 1 }
        ]
      });
      await client.waitFor(
        (f) => f.t === 'EOSE' && f.sid === 9 && f.wave === 'w2'
      );
      const of = (sid: number, t: string) =>
        client.frames.filter((f) => f.t === t && f.sid === sid);
      expect(
        of(9, 'EV').map((f) => [f.wave, f.rseq, (f.event as { id: string }).id])
      ).toEqual([
        ['w1', 2, 'c'],
        ['dv', 1, 'b'],
        ['dv', 2, 'd'],
        ['w2', 1, 'e']
      ]);
      expect(of(9, 'EOSE').map((f) => [f.wave, f.rseq])).toEqual([
        ['w1', 2],
        ['dv', 2],
        ['w2', 1]
      ]);
      client.send({
        t: 'SUB',
        sid: 10,
        waves: ['w1'],
        from_start: false,
        since: []
      });
      client.send({ t: 'HIST', rid: 6, wave: 'dv/0x2', after: 0, limit: 10 });
      const stream = await client.waitFor((f) => f.t === 'RES' && f.rid === 6);
      expect((stream.items as { rseq: number }[]).map((i) => i.rseq)).toEqual([
        2
      ]);
      client.send({ t: 'HIST', rid: 7, wave: 'w1', after: null, limit: 1 });
      const newest = await client.waitFor((f) => f.t === 'RES' && f.rid === 7);
      expect(newest).toMatchObject({
        more: true,
        items: [expect.objectContaining({ rseq: 2 })]
      });
      client.send({
        t: 'PUB',
        rid: 8,
        event: { id: 'f', wave: 'w1', kind: 9, body: null },
        grant: {}
      });
      expect(
        await client.waitFor((f) => f.t === 'EV' && f.sid === 10)
      ).toMatchObject({
        wave: 'w1',
        rseq: 3
      });
      await client.waitFor((f) => f.t === 'EV' && f.sid === 9 && f.rseq === 3);
      expect(of(10, 'EOSE')).toEqual([]);
      client.close();
    } finally {
      await relay.stop();
    }
  });
});

describe('relay checks', () => {
  it('checks a signed event as the relays do', () => {
    expect(checkSignedEvent(GOOD)).toEqual({ ok: true });
    const fail = (change: Record<string, unknown>) => {
      const result = checkSignedEvent({ ...GOOD, ...change });
      return result.ok ? 'passed' : result.reason;
    };
    expect(fail({ wave: 'dr/0xbb' })).toBe(
      'the id is not the digest of its fields'
    );
    expect(fail({ body: '{"h": "x"}' })).toBe('the body is not canonical JSON');
    expect(fail({ body: '{"h":"x"}' })).toBe(
      'the body does not match its hash and size'
    );
    expect(fail({ signature: `0x${'00'.repeat(64)}` })).toBe(
      "the signature is not the device key's"
    );
    expect(fail({ kind: 7 })).toBe("kind 7 is not a signed event's");
    expect(fail({ device_key: 'x' })).toBe(
      'not a signed event: a field is missing or malformed'
    );
  });

  it('runs the signed-event check before the area check', () => {
    const forged = { ...GOOD, signature: '0x00' };
    expect(
      verifyRelayItems(
        [
          { event: GOOD, grant: {} },
          { event: forged, grant: {} },
          { event: signedEvent({ wave: 'zz/0x1' }), grant: {} }
        ],
        [areaCheck(['dr/'])]
      )
    ).toEqual({
      events: 3,
      verified: 1,
      unchecked: { 'zz/0x1': 1 },
      failed: [
        {
          id: GOOD.id,
          wave: 'dr/0xaa',
          reason: "signed event: the signature is not the device key's"
        }
      ]
    });
  });

  it("names the checks to run, skipping a planned one whose module isn't here", () => {
    const manifest = (
      relayChecks: AreaManifest['relayChecks']
    ): AreaManifest => ({
      area: 'dm',
      flags: { KEY: 'k1' },
      tables: {},
      seeds: [],
      rebuilders: [],
      probes: [],
      relayChecks
    });
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const here = {
      module: 'src/rebuild/sources/relay-fixture',
      exportName: 'signedEvent'
    };
    expect(
      relayCheckSpecs(
        [
          manifest([
            { waves: ['dr/'], run: here },
            {
              waves: ['cv/'],
              run: { module: 'src/later', exportName: 'c' },
              origin: 'planned'
            }
          ])
        ],
        repoRoot
      )
    ).toEqual({
      specs: [{ area: 'dm', waves: ['dr/'], ...here, flags: { KEY: 'k1' } }],
      skipped: ['dm: src/later#c']
    });
    expect(() =>
      relayCheckSpecs(
        [
          manifest([
            { waves: ['x/'], run: { module: 'src/gone', exportName: 'c' } }
          ])
        ],
        repoRoot
      )
    ).toThrow('not in this tree');
  });

  it('runs the checks in a child under the source guard', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-relay-child-'));
    try {
      const dir = path.join(root, 'recording');
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'events.jsonl'),
        `${JSON.stringify({ rseq: 1, event: GOOD, grant: GRANT })}
`
      );
      const violations = path.join(root, 'violations.jsonl');
      const repoRoot = path.resolve(__dirname, '..', '..', '..');
      const module = 'src/rebuild/sources/relay-check.fixture';
      const verify = (exportName: string, flags: Record<string, string>) =>
        guardedVerifier({
          repoRoot,
          specs: [{ area: 'test', waves: ['dr/'], module, exportName, flags }],
          workDir: path.join(root, 'work'),
          logFile: path.join(root, 'relay-checks.log'),
          env: {
            ...(Object.fromEntries(
              Object.entries(process.env).filter(([, v]) => v !== undefined)
            ) as Record<string, string>),
            REBUILD_VIOLATIONS_FILE: violations,
            REBUILD_ALLOWED_ENDPOINTS: ''
          },
          timeoutMs: 120_000
        })([dir]);
      expect(await verify('passWhenAllowed', { ALLOW: 'yes' })).toEqual([
        { events: 1, verified: 1, unchecked: {}, failed: [] }
      ]);
      expect((await verify('passWhenAllowed', {}))[0].failed).toEqual([
        { id: GOOD.id, wave: 'dr/0xaa', reason: 'test: not allowed' }
      ]);
      await verify('reachOut', {});
      expect(fs.readFileSync(violations, 'utf8')).toContain('192.0.2.1:80');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);

  it('picks the longest wave prefix', () => {
    const broad = areaCheck(['d']);
    const narrow = areaCheck(['dr/']);
    expect(checkFor([broad, narrow], 'dr/0x1')).toBe(narrow);
    expect(checkFor([broad, narrow], 'dv/0x1')).toBe(broad);
    expect(checkFor([narrow], 'cv/0x1')).toBeNull();
  });
});
