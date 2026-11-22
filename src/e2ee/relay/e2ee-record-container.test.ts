import fc from 'fast-check';
import {
  decodeE2eeRecordContent,
  E2EE_RECORD_CONTAINER_TAG,
  E2eeExternalBytes,
  E2eeMissingBytes,
  E2eeRecordContainerError,
  e2eeSha256,
  encodeE2eeRecordContent
} from '@/e2ee/relay/e2ee-record-container';

describe('e2ee record container', () => {
  const content = {
    type: 'message',
    pos: 7,
    prev: `0x${'ab'.repeat(32)}`,
    ops: [
      {
        op: 'put' as const,
        table: 'e2ee_log',
        row: {
          group_handle: `0x${'01'.repeat(32)}`,
          seq: 7,
          data: new E2eeExternalBytes(Buffer.from('ciphertext')),
          kind: null,
          complete: true
        }
      },
      {
        op: 'put' as const,
        table: 'e2ee_welcomes',
        row: { id: '0x01', data: Buffer.from([1, 2, 3]), ratchet_tree: null }
      },
      {
        op: 'del' as const,
        table: 'e2ee_welcome_deliveries',
        key: { welcome_id: '0x01', device_key: '0x02' }
      }
    ]
  };

  it('round-trips rows, inline bytes and external bytes', () => {
    const encoded = encodeE2eeRecordContent(content);
    expect(encoded.content[0]).toBe(E2EE_RECORD_CONTAINER_TAG);
    expect(encoded.external).toEqual([Buffer.from('ciphertext')]);
    const byHash = new Map([
      [e2eeSha256(encoded.external[0]), encoded.external[0]]
    ]);
    const decoded = decodeE2eeRecordContent(
      encoded.content,
      (sha) => byHash.get(sha) ?? null
    );
    expect(decoded.type).toBe('message');
    expect(decoded.pos).toBe(7);
    expect(decoded.prev).toBe(content.prev);
    expect(decoded.external).toEqual([
      { sha256: e2eeSha256(Buffer.from('ciphertext')), length: 10 }
    ]);
    expect(decoded.ops[0]).toEqual({
      op: 'put',
      table: 'e2ee_log',
      row: {
        group_handle: content.ops[0].row.group_handle,
        seq: 7,
        data: Buffer.from('ciphertext'),
        kind: null,
        complete: true
      }
    });
    expect(decoded.ops[1]).toEqual(content.ops[1]);
    expect(decoded.ops[2]).toEqual(content.ops[2]);
  });

  it('decodes dropped external bytes as missing, never as other bytes', () => {
    const encoded = encodeE2eeRecordContent(content);
    const missing = decodeE2eeRecordContent(encoded.content);
    expect(missing.ops[0]).toMatchObject({
      row: { data: expect.any(E2eeMissingBytes) }
    });
    const wrong = decodeE2eeRecordContent(encoded.content, () =>
      Buffer.from('ciphertexX')
    );
    expect(wrong.ops[0]).toMatchObject({
      row: { data: expect.any(E2eeMissingBytes) }
    });
  });

  it('is deterministic: the same content gives the same bytes', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.stringMatching(/^[a-z_]{1,12}$/),
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.constant(null),
            fc.uint8Array({ maxLength: 64 }).map((bytes) => Buffer.from(bytes))
          )
        ),
        fc.integer({ min: 1, max: 1_000_000 }),
        (row, pos) => {
          const input = {
            type: 'roster',
            pos,
            prev: null,
            ops: [{ op: 'put' as const, table: 't', row }]
          };
          const first = encodeE2eeRecordContent(input).content;
          const second = encodeE2eeRecordContent(input).content;
          expect(first.equals(second)).toBe(true);
          const decoded = decodeE2eeRecordContent(first);
          expect(decoded.ops[0]).toEqual({ op: 'put', table: 't', row });
        }
      )
    );
  });

  it('refuses truncated, extended and foreign bytes', () => {
    const { content: bytes } = encodeE2eeRecordContent(content);
    expect(() =>
      decodeE2eeRecordContent(bytes.subarray(0, bytes.length - 1))
    ).toThrow(E2eeRecordContainerError);
    expect(() =>
      decodeE2eeRecordContent(Buffer.concat([bytes, Buffer.from([0])]))
    ).toThrow(E2eeRecordContainerError);
    const foreign = Buffer.from(bytes);
    foreign[0] = 0x01;
    expect(() => decodeE2eeRecordContent(foreign)).toThrow(
      'Not an e2ee record container'
    );
    expect(() => decodeE2eeRecordContent(Buffer.from([0x10]))).toThrow(
      'Too short'
    );
  });

  it('refuses to encode bytes it never had', () => {
    expect(() =>
      encodeE2eeRecordContent({
        type: 'x',
        pos: 1,
        prev: null,
        ops: [
          {
            op: 'put',
            table: 't',
            row: { data: new E2eeMissingBytes(`0x${'00'.repeat(32)}`, 1) }
          }
        ]
      })
    ).toThrow('has no bytes');
  });
});
