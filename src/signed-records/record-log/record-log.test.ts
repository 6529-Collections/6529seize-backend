import { createHash } from 'node:crypto';
import { RecordGrantProof, signRecordEvent } from '../record-event';
import { RecordKind } from '../record-kinds';
import {
  bindingSource,
  grantSource,
  hexBytes,
  VECTOR_GRANT,
  vectorDeviceKey,
  VECTORS
} from '../record-test-fixtures';
import { ProviderKey } from '../sealed-crypto';
import {
  buildSegmentFile,
  formatArchiveDrop,
  formatHeadDrop,
  parseArchiveDrop,
  parseHeadDrop,
  parseSegmentFile,
  RecordLogEntry,
  RecordLogFormatError,
  RecordLogSegmentHeader
} from './record-log-format';
import {
  RecordLogReader,
  RecordsWaveDrop,
  replayRecordLog
} from './record-log-reader';
import { RecordLogSegmenter, RecordLogWriter } from './record-log.service';
import { MemoryRecordLogStore } from './record-log-test-store';

const inputs = VECTORS.inputs;
const SERVICE_WALLET = `0x${'5'.repeat(40)}`;
const provider: ProviderKey = {
  id: inputs.providerKeyId,
  privateKey: hexBytes(inputs.providerPrivateKey),
  publicKey: hexBytes(inputs.providerPublicKey)
};
const GRANT: RecordGrantProof = {
  id: inputs.authRef,
  message: 'grant message',
  wallet_signature: `0x${'ab'.repeat(65)}`,
  chain_id: 1,
  wallet: inputs.author,
  device_key: inputs.deviceKey,
  scopes: ['post', 'edit', 'delete', 'react'],
  domain: 'localhost',
  expires_at: VECTOR_GRANT.expiresAt,
  revoked_at: null
};
const ctx = {};

const publicEntry: RecordLogEntry = {
  t: 'event',
  lane: 'personal',
  event: VECTORS.followRecord,
  grant: GRANT
};
const privateEntry: RecordLogEntry = {
  t: 'event',
  lane: 'personal',
  event: VECTORS.sealedSettings.event,
  grant: GRANT
};
const serviceEntry: RecordLogEntry = {
  t: 'entry',
  lane: 'subs',
  chain: 'public',
  body: { list: 'card 1', hash: 'abc' }
};

function header(
  changes: Partial<RecordLogSegmentHeader> = {}
): RecordLogSegmentHeader {
  return {
    t: 'segment',
    v: 1,
    chain: 'public',
    seq: 1,
    prev: null,
    opened_at: 1,
    closed_at: 2,
    entries: 2,
    ...changes
  };
}

/** Pins, archives and posts in memory, like IPFS, Arweave and the wave. */
class FakeNetwork {
  readonly ipfs = new Map<string, Buffer>();
  readonly arweave = new Map<string, Buffer>();
  readonly drops: RecordsWaveDrop[] = [];
  failPosts = 0;

  readonly pinner = {
    pin: async (bytes: Buffer) => {
      const cid = `bafy${createHash('sha256').update(bytes).digest('hex').slice(0, 40)}`;
      this.ipfs.set(cid, bytes);
      return cid;
    }
  };

  readonly archiver = {
    upload: async (bytes: Buffer) => {
      const tx = createHash('sha256')
        .update(bytes)
        .digest('base64url')
        .slice(0, 43);
      this.arweave.set(tx, bytes);
      return tx;
    }
  };

  readonly poster = {
    post: async (text: string) => {
      if (this.failPosts > 0) {
        this.failPosts--;
        throw new Error('relay down');
      }
      const dropId = `drop-${this.drops.length + 1}`;
      this.drops.push({ dropId, author: SERVICE_WALLET, text });
      return dropId;
    }
  };

  readonly fetcher = {
    fetchCid: async (cid: string) => {
      const bytes = this.ipfs.get(cid);
      if (!bytes) {
        throw new Error(`not pinned: ${cid}`);
      }
      return bytes;
    },
    fetchArweave: async (tx: string) => {
      const bytes = this.arweave.get(tx);
      if (!bytes) {
        throw new Error(`not on arweave: ${tx}`);
      }
      return bytes;
    }
  };

  reader(extraDrops: RecordsWaveDrop[] = []) {
    const drops = [...this.drops, ...extraDrops];
    return new RecordLogReader({
      wave: {
        drops: async function* () {
          yield* drops;
        }
      },
      fetcher: this.fetcher,
      serviceWallets: [SERVICE_WALLET],
      providers: [provider]
    });
  }
}

function setup(maxEntriesPerSegment?: number) {
  const store = new MemoryRecordLogStore();
  const network = new FakeNetwork();
  const writer = new RecordLogWriter(
    store,
    { findGrantProofs: async () => [GRANT] },
    () => 1000
  );
  let clock = 2000;
  const segmenter = new RecordLogSegmenter({
    store,
    pinner: network.pinner,
    archiver: network.archiver,
    poster: network.poster,
    providers: [provider],
    now: () => clock++,
    maxEntriesPerSegment
  });
  return { store, network, writer, segmenter };
}

async function collect(reader: RecordLogReader, chain: 'public' | 'private') {
  const items = [];
  for await (const item of reader.walk(chain)) {
    items.push(item);
  }
  return items;
}

describe('segment files', () => {
  it('round-trips a public segment as canonical JSON lines', () => {
    const bytes = buildSegmentFile({
      header: header(),
      entries: [publicEntry, serviceEntry],
      providers: []
    });
    expect(bytes.toString('utf8').split('\n')).toHaveLength(4);
    expect(parseSegmentFile(bytes, [])).toEqual({
      header: header(),
      entries: [publicEntry, serviceEntry]
    });
  });

  it('seals a private segment to the provider keys', () => {
    const bytes = buildSegmentFile({
      header: header({ chain: 'private', entries: 1 }),
      entries: [privateEntry],
      providers: [provider]
    });
    expect(bytes.toString('utf8')).not.toContain(inputs.deviceKey);
    expect(parseSegmentFile(bytes, [provider]).entries).toEqual([privateEntry]);
    expect(() =>
      parseSegmentFile(bytes, [{ ...provider, id: 'other-key' }])
    ).toThrow('no provider key');
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 5] ^= 1;
    expect(() => parseSegmentFile(tampered, [provider])).toThrow(
      RecordLogFormatError
    );
  });

  it('refuses entries of the other chain and wrong counts', () => {
    expect(() =>
      buildSegmentFile({
        header: header({ entries: 1 }),
        entries: [privateEntry],
        providers: []
      })
    ).toThrow('other chain');
    expect(() =>
      buildSegmentFile({
        header: header({ entries: 3 }),
        entries: [publicEntry, serviceEntry],
        providers: []
      })
    ).toThrow('count');
    const bytes = buildSegmentFile({
      header: header(),
      entries: [publicEntry, serviceEntry],
      providers: []
    });
    const edited = Buffer.from(
      bytes.toString('utf8').replace('"entries":2', '"entries":1')
    );
    expect(() => parseSegmentFile(edited, [])).toThrow('count');
  });

  it('formats and parses head and archive drops', () => {
    const head = {
      chain: 'private' as const,
      seq: 3,
      sha256: 'a'.repeat(64),
      cid: 'bafy0123456789',
      prev: 'b'.repeat(64),
      entries: 12
    };
    expect(parseHeadDrop(formatHeadDrop(head))).toEqual(head);
    expect(
      parseHeadDrop(formatHeadDrop({ ...head, seq: 1, prev: null }))
    ).toEqual({ ...head, seq: 1, prev: null });
    expect(parseHeadDrop('gm')).toBeNull();
    const archives = [
      {
        chain: 'public' as const,
        seq: 1,
        sha256: 'c'.repeat(64),
        arweaveTx: 'x'.repeat(43)
      }
    ];
    expect(parseArchiveDrop(formatArchiveDrop(archives))).toEqual(archives);
    expect(parseArchiveDrop(formatHeadDrop(head))).toBeNull();
  });
});

describe('the record log', () => {
  it('closes hash-chained segments per chain, posts heads and walks them back', async () => {
    const { network, writer, segmenter } = setup();
    await writer.append([publicEntry, privateEntry, serviceEntry], ctx);
    const first = await segmenter.closeSegments(ctx);
    expect(first.map((head) => [head.chain, head.seq, head.entries])).toEqual([
      ['public', 1, 2],
      ['private', 1, 1]
    ]);
    await writer.appendEvents('personal', [VECTORS.followUnset], ctx);
    const second = await segmenter.closeSegments(ctx);
    expect(second).toEqual([
      expect.objectContaining({
        chain: 'public',
        seq: 2,
        prev: first[0].sha256
      })
    ]);
    expect(await segmenter.closeSegments(ctx)).toEqual([]);
    expect(network.drops).toHaveLength(3);

    const publicItems = await collect(network.reader(), 'public');
    expect(publicItems.map((item) => item.entry)).toEqual([
      publicEntry,
      serviceEntry,
      { t: 'event', lane: 'personal', event: VECTORS.followUnset, grant: GRANT }
    ]);
    const privateItems = await collect(network.reader(), 'private');
    expect(privateItems.map((item) => item.entry)).toEqual([privateEntry]);
  });

  it('replays events with verification for a rebuild', async () => {
    const { network, writer, segmenter } = setup();
    await writer.append([publicEntry, serviceEntry], ctx);
    await segmenter.closeSegments(ctx);
    const seen: string[] = [];
    const count = await replayRecordLog(
      network.reader(),
      'public',
      {
        grants: grantSource([VECTOR_GRANT]),
        bindings: bindingSource([
          { wallet: inputs.author, principal: inputs.principal, from: 1 }
        ])
      },
      async (item, verified) => {
        seen.push(
          `${item.entry.t}:${verified === null ? 'service' : verified.ok}`
        );
      }
    );
    expect(count).toBe(2);
    expect(seen).toEqual(['event:true', 'entry:service']);
  });

  it('splits large batches and keeps the order', async () => {
    const { network, writer, segmenter } = setup(2);
    const events = [1, 2, 3, 4, 5].map((n) =>
      signRecordEvent(
        {
          kind: RecordKind.RECORD,
          wave: `ps/${inputs.principal}`,
          refs: ['follow', `wave:w${n}`],
          body: {},
          author: inputs.author,
          deviceKey: inputs.deviceKey,
          authRef: inputs.authRef,
          seq: 100 + n,
          anchor: 1000,
          claimedTime: 100 + n
        },
        vectorDeviceKey()
      )
    );
    await writer.appendEvents('personal', events, ctx);
    const heads = await segmenter.closeSegments(ctx);
    expect(heads.map((head) => head.entries)).toEqual([2, 2, 1]);
    const items = await collect(network.reader(), 'public');
    expect(
      items.map((item) => (item.entry.t === 'event' ? item.entry.event.seq : 0))
    ).toEqual([101, 102, 103, 104, 105]);
  });

  it('posts heads in order once the wave takes them again', async () => {
    const { network, store, writer, segmenter } = setup();
    network.failPosts = 1;
    await writer.append([publicEntry], ctx);
    await segmenter.closeSegments(ctx);
    expect(store.segments[0].head_drop_id).toBeNull();
    await writer.append([serviceEntry], ctx);
    await segmenter.closeSegments(ctx);
    expect(store.segments.map((row) => row.head_drop_id)).toEqual([
      'drop-1',
      'drop-2'
    ]);
    expect(network.drops.map((drop) => parseHeadDrop(drop.text)?.seq)).toEqual([
      1, 2
    ]);
  });

  it('archives hourly, frees the stored file and reads from Arweave when IPFS lost it', async () => {
    const { network, store, writer, segmenter } = setup();
    await writer.append([publicEntry], ctx);
    await segmenter.closeSegments(ctx);
    expect(await segmenter.archive(ctx)).toBe(1);
    expect(store.segments[0]).toMatchObject({ content: null });
    expect(store.segments[0].arweave_tx).not.toBeNull();
    expect(await segmenter.archive(ctx)).toBe(0);
    network.ipfs.clear();
    const items = await collect(network.reader(), 'public');
    expect(items.map((item) => item.entry)).toEqual([publicEntry]);
  });

  it('refuses a missing head, a conflicting head and a changed file', async () => {
    const { network, writer, segmenter } = setup();
    await writer.append([publicEntry], ctx);
    await segmenter.closeSegments(ctx);
    await writer.append([serviceEntry], ctx);
    await segmenter.closeSegments(ctx);

    const firstHead = network.drops[0];
    const withoutFirst = new FakeNetwork();
    withoutFirst.ipfs.clear();
    network.ipfs.forEach((bytes, cid) => withoutFirst.ipfs.set(cid, bytes));
    withoutFirst.drops.push(network.drops[1]);
    await expect(collect(withoutFirst.reader(), 'public')).rejects.toThrow(
      'segment 1 has no head'
    );

    const head = parseHeadDrop(firstHead.text)!;
    const conflicting = {
      dropId: 'drop-x',
      author: SERVICE_WALLET,
      text: formatHeadDrop({ ...head, sha256: 'f'.repeat(64) })
    };
    await expect(
      collect(network.reader([conflicting]), 'public')
    ).rejects.toThrow('two heads');

    const foreign = { ...conflicting, author: `0x${'9'.repeat(40)}` };
    await expect(
      collect(network.reader([foreign]), 'public')
    ).resolves.toHaveLength(2);

    const [cid, bytes] = Array.from(network.ipfs.entries())[0];
    network.ipfs.set(cid, Buffer.concat([bytes, Buffer.from(' ')]));
    await expect(collect(network.reader(), 'public')).rejects.toThrow(
      'does not match its head'
    );
  });
});
