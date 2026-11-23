import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  loopbackPort,
  peerSettings,
  withLoopbackListen
} from '@/rebuild/sources/frozen-config';
import {
  FROZEN_OPTION,
  FrozenExchange,
  FrozenHeader,
  frozenHeaderProblems,
  FrozenSnapshot,
  frozenNotes,
  FrozenValidator,
  startFrozenNode,
  unpackSnapshot,
  validatorProblems,
  verifyFrozenRecording
} from '@/rebuild/sources/frozen-gateway';
import { takeFrozenLock } from '@/rebuild/sources/frozen-guard';
import { exchangeKey } from '@/rebuild/sources/http-recording';
import { extractTar, readTar } from '@/rebuild/sources/tar-reader';

const sha256 = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

/** A tar entry's 512-byte header, ustar, with its checksum. */
function header(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0);
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
  block.write(type, 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  block.fill(' ', 148, 156);
  const sum = block.reduce((n, byte) => n + byte, 0);
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

function tar(entries: { name: string; body?: string; type?: string }[]) {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    if (entry.name.length > 100) {
      const long = Buffer.from(`${entry.name}\0`);
      parts.push(header('././@LongLink', long.length, 'L'));
      parts.push(long, Buffer.alloc((512 - (long.length % 512)) % 512));
    }
    parts.push(header(entry.name, body.length, entry.type ?? '0'));
    parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

describe('tar reader', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-tar-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads files, directories and GNU long names', () => {
    const long = `chain/${'x'.repeat(120)}/state.db`;
    const entries = readTar(
      tar([
        { name: 'chain/', type: '5' },
        { name: 'config.toml', body: 'a = 1\n' },
        { name: long, body: 'state' }
      ])
    );
    expect(entries.map((e) => [e.name, e.type, e.bytes.toString()])).toEqual([
      ['chain/', 'directory', ''],
      ['config.toml', 'file', 'a = 1\n'],
      [long, 'file', 'state']
    ]);
  });

  it('unpacks into a folder, and refuses a name outside it or a link', () => {
    expect(extractTar(tar([{ name: 'data/a.txt', body: 'a' }]), dir)).toEqual([
      'data/a.txt'
    ]);
    expect(fs.readFileSync(path.join(dir, 'data', 'a.txt'), 'utf8')).toBe('a');
    expect(() =>
      extractTar(tar([{ name: '../escape.txt', body: 'x' }]), dir)
    ).toThrow('outside the folder');
    expect(fs.existsSync(path.join(dir, '..', 'escape.txt'))).toBe(false);
    expect(() => readTar(tar([{ name: 'link', type: '2' }]))).toThrow(
      'not a file or a directory'
    );
  });
});

describe('frozen node lock', () => {
  let lockDir: string;
  beforeEach(() => {
    lockDir = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-lock-')),
      'frozen.lock'
    );
  });
  afterEach(() =>
    fs.rmSync(path.dirname(lockDir), { recursive: true, force: true })
  );

  it('lets one frozen node run at a time', () => {
    const first = takeFrozenLock('the first run', lockDir);
    expect('release' in first).toBe(true);
    // A second holder, here another live process: this test's parent.
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({
        pid: process.ppid,
        startedAt: 'earlier',
        purpose: 'another run'
      })
    );
    const second = takeFrozenLock('the second run', lockDir);
    expect(second).toEqual({
      refused: `another frozen node is running (process ${process.ppid}, since earlier, for another run); one runs at a time`
    });
    if ('release' in first) first.release();
    expect(fs.existsSync(lockDir)).toBe(false);
    const third = takeFrozenLock('the third run', lockDir);
    expect('release' in third).toBe(true);
  });

  it('takes over a lock whose holder has exited', () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 2 ** 22 + 7, startedAt: 'x', purpose: 'gone' })
    );
    expect('release' in takeFrozenLock('a new run', lockDir)).toBe(true);
  });
});

describe('frozen node configuration', () => {
  const config = [
    '[chain]',
    'genesis = "../devnet.toml"',
    '',
    '[chain.api]',
    'listen = "0.0.0.0:7400"',
    '',
    '[p2p]',
    'bootstrap = []',
    'listen = []'
  ].join('\n');

  it('binds the chain API to 127.0.0.1 on the given port', () => {
    expect(loopbackPort(config)).toBeNull();
    const bound = withLoopbackListen(config, 3411);
    expect(loopbackPort(bound)).toBe(3411);
    expect(bound).toContain('genesis = "../devnet.toml"');
    expect(loopbackPort(withLoopbackListen('[chain]\na = 1\n', 3411))).toBe(
      3411
    );
  });

  it('names every peer setting a frozen copy must not have', () => {
    expect(peerSettings(config)).toEqual([]);
    expect(
      peerSettings(
        [
          '[p2p]',
          'bootstrap = ["/ip4/192.0.2.1/tcp/7401"]',
          'relays = []',
          'onion = true',
          'relay_service = false'
        ].join('\n')
      )
    ).toEqual([
      'p2p.bootstrap = ["/ip4/192.0.2.1/tcp/7401"]',
      'p2p.onion = true'
    ]);
  });
});

/**
 * A stand-in validator: `run --help` lists the option, and `run
 * --api-frozen-snapshot --data-dir <dir>` serves <dir>/answers.json on the
 * config's [chain.api] listen, as the frozen node does. FAKE_BIND moves it
 * off 127.0.0.1, as a node that ignored its config would.
 */
const STAND_IN = `
const fs = require('fs');
const http = require('http');
const path = require('path');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('validator run --api-frozen-snapshot [--data-dir DIR] [--config FILE]');
  process.exit(0);
}
const dir = args[args.indexOf('--data-dir') + 1];
const config = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
const [, host, port] = /listen = "([^:]+):(\\d+)"/.exec(config);
const answers = JSON.parse(fs.readFileSync(path.join(dir, 'answers.json'), 'utf8'));
const bind = process.env.FAKE_BIND || host;
http.createServer((req, res) => {
  const a = answers[req.url];
  if (!a) { res.writeHead(404); res.end(); return; }
  res.writeHead(a.status, { 'content-type': a.contentType });
  res.end(a.body);
}).listen(Number(port), bind, () => {
  console.log('Frozen snapshot, for recordings: the chain API serves ' + dir + ' at height 9 on ' + bind + ':' + port + ', from a copy.');
});
`;

const ROOT_A = `0x${'a'.repeat(64)}`;
const ROOT_B = `0x${'b'.repeat(64)}`;

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('frozen gateway recordings', () => {
  let root: string;
  let dir: string;
  let lockDir: string;
  let validator: FrozenValidator;
  const statusBody = JSON.stringify({
    data: { snapshot: { height: 9, root: ROOT_A, appStateRoot: ROOT_B } }
  });
  const answers = {
    '/v1/status': {
      status: 200,
      contentType: 'application/json',
      body: statusBody
    },
    '/v1/membership?height=9': {
      status: 200,
      contentType: 'application/json',
      body: '{"members":["0x01"]}'
    }
  };
  const line = (urlPath: string, snapshot = 'mark'): FrozenExchange => {
    const answer = answers[urlPath as keyof typeof answers];
    return {
      key: exchangeKey('GET', urlPath, Buffer.alloc(0)),
      method: 'GET',
      path: urlPath,
      status: answer.status,
      contentType: answer.contentType,
      body: answer.body,
      encoding: 'utf8',
      snapshot
    };
  };
  const lines = () => [line('/v1/status'), line('/v1/membership?height=9')];
  let header: FrozenHeader & { frozen: FrozenSnapshot[] };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-frozen-'));
    dir = path.join(root, 'recording');
    lockDir = path.join(root, 'frozen.lock');
    fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'devnet.toml'), '[devnet]\n');
    const copy = tar([
      {
        name: 'config.toml',
        body: '[devnet]\ngenesis = "../devnet.toml"\n\n[chain.api]\nlisten = "127.0.0.1:1"\n\n[p2p]\nbootstrap = []\n'
      },
      { name: 'answers.json', body: JSON.stringify(answers) }
    ]);
    const archive = gzipSync(copy);
    const tarHash = sha256(copy);
    fs.writeFileSync(path.join(dir, 'snapshots', `${tarHash}.tar.gz`), archive);
    const script = path.join(root, 'validator.cjs');
    fs.writeFileSync(script, STAND_IN);
    validator = { file: script, command: [process.execPath, script] };
    header = {
      validatorCommit: 'c'.repeat(40),
      validatorSha256Windows: sha256(fs.readFileSync(script)),
      validatorSha256Linux: sha256(fs.readFileSync(script)),
      answers: 2,
      answersServedFrozen: 2,
      frozen: [
        {
          phase: 'mark',
          option: FROZEN_OPTION,
          height: 9,
          blockRoot: ROOT_A,
          appStateRoot: ROOT_B,
          dataDirSha256: tarHash,
          dataDirArchive: `${tarHash}.tar.gz`,
          dataDirArchiveSha256: sha256(archive),
          copiedNode: 'node-0',
          liveNodes: ['node-1', 'node-2'].map((node) => ({
            node,
            height: 9,
            status: 200,
            blockRoot: ROOT_A,
            appStateRoot: ROOT_B
          }))
        }
      ]
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('checks the header: the snapshot, two other live nodes, every answer tagged', () => {
    expect(frozenHeaderProblems(header, lines())).toEqual([]);
    const [snapshot] = header.frozen;
    const bad: FrozenHeader = {
      ...header,
      answersServedFrozen: 1,
      frozen: [
        {
          ...snapshot,
          dataDirArchive: 'other.tar.gz',
          liveNodes: [
            { ...snapshot.liveNodes[0], node: 'node-0' },
            { ...snapshot.liveNodes[1], appStateRoot: ROOT_A }
          ]
        }
      ]
    };
    expect(
      frozenHeaderProblems(bad, [
        ...lines(),
        { ...line('/v1/status'), path: '/v1/x', snapshot: 'other' }
      ])
    ).toEqual([
      "snapshot mark's archive isn't named by the copy's hash",
      'snapshot mark has fewer than two live nodes other than the copied one',
      "snapshot mark's live node node-0 is the copied node",
      "snapshot mark's live node node-2 reported other roots at height 9",
      '1 answers name no snapshot of the header, first GET /v1/x',
      'the header counts 2 answers, 1 served frozen, for 3 recorded'
    ]);
    expect(frozenHeaderProblems({ ...header, frozen: [] }, [])).toEqual([
      'the header names no frozen snapshot'
    ]);
  });

  it('refuses a header that leaves out the build that served it', () => {
    expect(
      frozenHeaderProblems(
        {
          ...header,
          validatorCommit: 'c'.repeat(12),
          validatorSha256Windows: undefined
        },
        lines()
      )
    ).toEqual([
      'the header names no full validatorCommit',
      'the header names no validatorSha256Windows'
    ]);
    expect(
      frozenHeaderProblems(
        { ...header, validatorSha256Linux: undefined },
        lines()
      )
    ).toEqual(['the header names no validatorSha256Linux']);
  });

  it("replays only with the recording's build for the platform", () => {
    const served = sha256(fs.readFileSync(validator.file));
    const other = { ...header, validatorSha256Windows: 'f'.repeat(64) };
    expect(validatorProblems(validator, other, 'win32')).toEqual([
      `replay binary ${served} is not the recording's validatorSha256Windows ${'f'.repeat(64)}`
    ]);
    expect(validatorProblems(validator, other, 'linux')).toEqual([]);
    expect(
      validatorProblems(
        validator,
        { ...header, validatorSha256Linux: 'f'.repeat(64) },
        'linux'
      )
    ).toEqual([
      `replay binary ${served} is not the recording's validatorSha256Linux ${'f'.repeat(64)}`
    ]);
  });

  it('re-serves the kept copy and replays its answers: final once reviewed', async () => {
    const port = await freePort();
    const verify = (reviewedCommit?: string, recorded = lines()) =>
      verifyFrozenRecording({
        dir,
        header,
        lines: recorded,
        workDir: path.join(root, 'work'),
        validator,
        port,
        reviewedCommit,
        lockDir
      });
    expect(await verify('c'.repeat(40))).toEqual({
      problems: [],
      provisionalWhy: null
    });
    expect((await verify()).provisionalWhy).toBe(
      `its validator (${'c'.repeat(40)}) isn't marked reviewed (--frozen-reviewed)`
    );
    // A hand-edited answer doesn't replay.
    const edited = lines();
    edited[1] = { ...edited[1], body: '{"members":["0x02"]}' };
    expect((await verify('c'.repeat(40), edited)).problems).toEqual([
      'GET /v1/membership?height=9: the frozen node answers 200 with other bytes than the recording'
    ]);
    // The frozen node is stopped, its lock given back and its temp gone.
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(fs.existsSync(path.join(root, 'work', 'mark', 'tmp'))).toBe(false);
    // An answer tagged after the capture keeps it from being final, and
    // is left out of the replay: here an edited one, which would fail it.
    header = { ...header, retagged: [{ key: edited[1].key }] };
    expect(await verify('c'.repeat(40), edited)).toEqual({
      problems: [],
      provisionalWhy:
        "1 answers were tagged with their snapshot after the capture (retagged), so the recording can't be final"
    });
    expect((await verify('c'.repeat(40))).provisionalWhy).toBe(
      "1 answers were tagged with their snapshot after the capture (retagged), so the recording can't be final"
    );
  });

  describe('answers listed as not replayable', () => {
    const counted = (recorded: FrozenExchange[]) => ({
      ...header,
      answersServedFrozen: 1,
      notReplayable: [
        {
          key: recorded[0].key,
          snapshot: 'mark',
          fields: ['data.requests'],
          why: 'the serving process counts its requests'
        }
      ]
    });
    // The recorded status carries a counter the frozen node's lacks.
    const withCounter = (extra: Record<string, unknown> = {}) => {
      const recorded = lines();
      const body = JSON.parse(recorded[0].body) as { data: object };
      recorded[0] = {
        ...recorded[0],
        body: JSON.stringify({ data: { ...body.data, requests: 2, ...extra } })
      };
      return recorded;
    };

    it('counts them in the header, and refuses an unknown key, a missing field or reason, or a repeat', () => {
      const recorded = withCounter();
      expect(frozenHeaderProblems(counted(recorded), recorded)).toEqual([]);
      // Listed, but still counted as served frozen.
      expect(
        frozenHeaderProblems(
          { ...counted(recorded), answersServedFrozen: 2 },
          recorded
        )
      ).toEqual([
        'the header counts 2 answers, 2 served frozen and 1 not replayable, for 2 recorded'
      ]);
      const [entry] = counted(recorded).notReplayable;
      expect(
        frozenHeaderProblems(
          {
            ...counted(recorded),
            answersServedFrozen: -1,
            notReplayable: [
              { ...entry, key: 'GET /v1/elsewhere' },
              { ...entry, fields: [], why: ' ' },
              entry
            ]
          },
          recorded
        )
      ).toEqual([
        "notReplayable GET /v1/elsewhere isn't a recorded answer of snapshot mark",
        `notReplayable ${entry.key} names no field`,
        `notReplayable ${entry.key} gives no reason`,
        `notReplayable ${entry.key} is listed twice`
      ]);
    });

    it('replays them without their fields: provisional when the rest matches, failed when it does not', async () => {
      const port = await freePort();
      const verify = (recorded: FrozenExchange[]) =>
        verifyFrozenRecording({
          dir,
          header: counted(recorded),
          lines: recorded,
          workDir: path.join(root, 'work'),
          validator,
          port,
          // Reviewed, so only the listed answer keeps it from being final,
          // and a final run fails on it.
          reviewedCommit: 'c'.repeat(40),
          lockDir
        });
      expect(await verify(withCounter())).toEqual({
        problems: [],
        provisionalWhy:
          "1 answer can't replay (notReplayable: GET /v1/status, data.requests)"
      });
      expect((await verify(withCounter({ node: 'other' }))).problems).toEqual([
        "GET /v1/status: the frozen node's answer differs outside its notReplayable fields (data.requests), at data.node"
      ]);
    });
  });

  it('notes a Windows binary built from another commit than the capture', () => {
    expect(
      frozenNotes(
        { ...header, validatorWindowsCommit: 'd'.repeat(40) },
        'win32'
      )
    ).toEqual([
      `the Windows binary that re-served the copies was built from ${'d'.repeat(40)}, the capture's from ${'c'.repeat(40)}; the replay is keyed on validatorSha256Windows`
    ]);
    expect(
      frozenNotes(
        { ...header, validatorWindowsCommit: 'd'.repeat(40) },
        'linux'
      )
    ).toEqual([]);
    expect(
      frozenNotes(
        { ...header, validatorWindowsCommit: 'c'.repeat(40) },
        'win32'
      )
    ).toEqual([]);
    expect(
      frozenHeaderProblems(
        { ...header, validatorWindowsCommit: 'd'.repeat(12) },
        lines()
      )
    ).toEqual(["the header's validatorWindowsCommit isn't in full"]);
  });

  it('stays provisional without a validator, and fails on a copy or binary that differs', async () => {
    const base = {
      dir,
      header,
      lines: lines(),
      workDir: path.join(root, 'work'),
      lockDir
    };
    expect(await verifyFrozenRecording(base)).toEqual({
      problems: [],
      provisionalWhy:
        'frozen copies not re-served: no --validator-bin and --frozen-port'
    });
    const port = await freePort();
    const otherBinary = await verifyFrozenRecording({
      ...base,
      header: {
        ...header,
        validatorSha256Windows: 'f'.repeat(64),
        validatorSha256Linux: 'f'.repeat(64)
      },
      validator,
      port
    });
    expect(otherBinary.problems[0]).toMatch(
      /^replay binary [0-9a-f]{64} is not the recording's/
    );
    const archive = path.join(
      dir,
      'snapshots',
      header.frozen[0].dataDirArchive
    );
    fs.appendFileSync(archive, 'x');
    expect(
      (await verifyFrozenRecording({ ...base, validator, port })).problems
    ).toEqual([
      "snapshot mark: the archive doesn't match its hash in the header"
    ]);
  });

  it('refuses a node that names a peer, binds elsewhere, or would run beside another', async () => {
    const port = await freePort();
    const folder = path.join(root, 'copy');
    const start = (
      extra: Partial<Parameters<typeof startFrozenNode>[0]> = {}
    ) =>
      startFrozenNode({
        validator,
        folder,
        port,
        tmpDir: path.join(root, 'tmp'),
        logFile: path.join(root, 'node.log'),
        lockDir,
        readyTimeoutMs: 20_000,
        ...extra
      });
    unpackSnapshot(dir, header.frozen[0], folder);
    const config = path.join(folder, 'config.toml');
    const peerless = fs.readFileSync(config, 'utf8');
    fs.writeFileSync(
      config,
      peerless.replace(
        'bootstrap = []',
        'bootstrap = ["/ip4/192.0.2.1/tcp/7401"]'
      )
    );
    await expect(start()).rejects.toThrow(
      'the copy\'s config names peers: p2p.bootstrap = ["/ip4/192.0.2.1/tcp/7401"]'
    );
    fs.writeFileSync(config, peerless);
    process.env.FAKE_BIND = '0.0.0.0';
    try {
      await expect(start()).rejects.toThrow(
        'the frozen node is not serving on 127.0.0.1'
      );
    } finally {
      delete process.env.FAKE_BIND;
    }
    expect(fs.existsSync(lockDir)).toBe(false);
    const node = await start();
    try {
      await expect(start({ port: await freePort() })).rejects.toThrow(
        'another frozen node is running'
      );
    } finally {
      await node.stop();
    }
  });
});
