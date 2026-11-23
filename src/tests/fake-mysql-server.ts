import { authPlugins, type Connection } from 'mysql2';
import { randomBytes } from 'node:crypto';
import * as net from 'node:net';

/*
 * A minimal MySQL server for driver tests that need no database: it speaks the
 * 4.1 protocol far enough for a client to log in (natively or by switching to
 * mysql_clear_password, as RDS Proxy does for IAM tokens), ping, and run text
 * queries whose replies the test scripts.
 */

const CLIENT = {
  LONG_PASSWORD: 0x1,
  FOUND_ROWS: 0x2,
  LONG_FLAG: 0x4,
  CONNECT_WITH_DB: 0x8,
  PROTOCOL_41: 0x200,
  TRANSACTIONS: 0x2000,
  SECURE_CONNECTION: 0x8000,
  MULTI_RESULTS: 0x20000,
  PLUGIN_AUTH: 0x80000,
  CONNECT_ATTRS: 0x100000,
  PLUGIN_AUTH_LENENC_CLIENT_DATA: 0x200000,
  SESSION_TRACK: 0x800000
} as const;

const SERVER_CAPABILITIES = Object.values(CLIENT).reduce((a, b) => a | b, 0);

/** Column type codes (MYSQL_TYPE_*). */
export const FIELD_TYPE = {
  DECIMAL: 0x00,
  TINY: 0x01,
  SHORT: 0x02,
  LONG: 0x03,
  FLOAT: 0x04,
  DOUBLE: 0x05,
  NULL: 0x06,
  TIMESTAMP: 0x07,
  LONGLONG: 0x08,
  INT24: 0x09,
  DATE: 0x0a,
  TIME: 0x0b,
  DATETIME: 0x0c,
  YEAR: 0x0d,
  BIT: 0x10,
  JSON: 0xf5,
  NEWDECIMAL: 0xf6,
  BLOB: 0xfc,
  VAR_STRING: 0xfd,
  STRING: 0xfe
} as const;

const CHARSET_UTF8MB4 = 45;
const CHARSET_BINARY = 63;
const BINARY_FLAG = 0x80;
const TEXT_TYPES: ReadonlySet<number> = new Set([
  FIELD_TYPE.VAR_STRING,
  FIELD_TYPE.STRING,
  FIELD_TYPE.BLOB
]);

export interface FakeColumn {
  readonly name: string;
  readonly type: number;
  /** Text columns default to utf8mb4; others to binary, as MySQL sends them. */
  readonly binary?: boolean;
}

export type FakeReply =
  | {
      readonly columns: readonly FakeColumn[];
      readonly rows: readonly (readonly (string | Buffer | null)[])[];
    }
  | {
      readonly affectedRows?: number;
      readonly insertId?: number;
      readonly info?: string;
    }
  | { readonly error: { errno: number; sqlState: string; message: string } }
  /** Never answer, as a connection lost without a FIN would. */
  | { readonly hang: true };

export interface FakeLogin {
  readonly user: string;
  readonly database: string;
  readonly clientPlugin: string | null;
  /** The answer to a mysql_clear_password switch, without its NUL. */
  readonly clearPassword: string | null;
}

export interface FakeMysqlServerOptions {
  /** Ask every client to switch to mysql_clear_password, as RDS Proxy IAM does. */
  readonly clearPassword?: boolean;
  /** Ask every client to switch to this plugin instead. */
  readonly switchTo?: string;
  /** Native password every login must prove; any password when absent. */
  readonly password?: string;
  readonly onQuery?: (sql: string) => FakeReply;
  /** Reply to COM_PING; OK when absent. */
  readonly onPing?: (connectionId: number) => FakeReply | undefined;
}

function lengthEncodedInt(value: number): Buffer {
  if (value < 251) return Buffer.from([value]);
  if (value < 2 ** 16) {
    const buffer = Buffer.alloc(3);
    buffer[0] = 0xfc;
    buffer.writeUInt16LE(value, 1);
    return buffer;
  }
  if (value < 2 ** 24) {
    const buffer = Buffer.alloc(4);
    buffer[0] = 0xfd;
    buffer.writeUIntLE(value, 1, 3);
    return buffer;
  }
  const buffer = Buffer.alloc(9);
  buffer[0] = 0xfe;
  buffer.writeBigUInt64LE(BigInt(value), 1);
  return buffer;
}

function lengthEncodedString(value: string | Buffer): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return Buffer.concat([lengthEncodedInt(bytes.length), bytes]);
}

function nulString(value: string): Buffer {
  return Buffer.from(`${value}\0`, 'utf8');
}

/** The answer mysql2's own mysql_native_password plugin gives for a seed. */
function nativePasswordAnswer(password: string, seed: Buffer): Buffer {
  const plugin = authPlugins.mysql_native_password({ password })({
    connection: { config: {} } as Connection,
    command: ''
  });
  return plugin(seed) as Buffer;
}

class PacketReader {
  constructor(
    private readonly data: Buffer,
    private offset = 0
  ) {}

  remaining(): number {
    return this.data.length - this.offset;
  }

  bytes(length: number): Buffer {
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  int(length: number): number {
    const value = this.data.readUIntLE(this.offset, length);
    this.offset += length;
    return value;
  }

  lengthEncodedInt(): number {
    const first = this.int(1);
    if (first < 0xfb) return first;
    if (first === 0xfc) return this.int(2);
    if (first === 0xfd) return this.int(3);
    return Number(this.bytes(8).readBigUInt64LE(0));
  }

  nulString(): string {
    const end = this.data.indexOf(0, this.offset);
    const value = this.data.toString('utf8', this.offset, end);
    this.offset = end + 1;
    return value;
  }

  rest(): Buffer {
    return this.bytes(this.remaining());
  }
}

/** Splits a socket's byte stream into MySQL packets. */
class PacketStream {
  private buffered = Buffer.alloc(0);

  constructor(
    private readonly onPacket: (sequenceId: number, payload: Buffer) => void
  ) {}

  push(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUIntLE(0, 3);
      if (this.buffered.length < 4 + length) return;
      const sequenceId = this.buffered[3];
      const payload = this.buffered.subarray(4, 4 + length);
      this.buffered = this.buffered.subarray(4 + length);
      this.onPacket(sequenceId, payload);
    }
  }
}

type Phase = 'handshake' | 'auth-switch' | 'command';

class FakeConnection {
  private phase: Phase = 'handshake';
  private sequenceId = 0;
  private clientFlags = 0;
  private login: Omit<FakeLogin, 'clearPassword'> | null = null;
  // Printable, never NUL, like a real server's scramble.
  private readonly seed = Buffer.from(
    randomBytes(20).map((byte) => (byte % 94) + 33)
  );
  private readonly packets = new PacketStream((sequenceId, payload) =>
    this.handle(sequenceId, payload)
  );

  constructor(
    readonly id: number,
    readonly socket: net.Socket,
    private readonly server: FakeMysqlServer
  ) {
    socket.on('data', (chunk) => this.packets.push(chunk));
    socket.on('error', () => undefined);
    this.greet();
  }

  private send(payload: Buffer): void {
    const header = Buffer.alloc(4);
    header.writeUIntLE(payload.length, 0, 3);
    header[3] = this.sequenceId++ & 0xff;
    this.socket.write(Buffer.concat([header, payload]));
  }

  private greet(): void {
    const capabilities = Buffer.alloc(4);
    capabilities.writeUInt32LE(SERVER_CAPABILITIES);
    const connectionId = Buffer.alloc(4);
    connectionId.writeUInt32LE(this.id);
    this.send(
      Buffer.concat([
        Buffer.from([10]),
        nulString('8.0.36-fake'),
        connectionId,
        this.seed.subarray(0, 8),
        Buffer.from([0]),
        capabilities.subarray(0, 2),
        Buffer.from([CHARSET_UTF8MB4]),
        Buffer.from([0x02, 0x00]),
        capabilities.subarray(2, 4),
        Buffer.from([21]),
        Buffer.alloc(10),
        this.seed.subarray(8, 20),
        Buffer.from([0]),
        nulString('mysql_native_password')
      ])
    );
  }

  private handle(sequenceId: number, payload: Buffer): void {
    this.sequenceId = sequenceId + 1;
    if (this.phase === 'handshake') this.handshakeResponse(payload);
    else if (this.phase === 'auth-switch') this.authSwitchResponse(payload);
    else this.command(payload);
  }

  private handshakeResponse(payload: Buffer): void {
    const reader = new PacketReader(payload);
    this.clientFlags = reader.int(4);
    reader.bytes(4 + 1 + 23);
    const user = reader.nulString();
    let authResponse: Buffer;
    if (this.clientFlags & CLIENT.PLUGIN_AUTH_LENENC_CLIENT_DATA) {
      authResponse = reader.bytes(reader.lengthEncodedInt());
    } else if (this.clientFlags & CLIENT.SECURE_CONNECTION) {
      authResponse = reader.bytes(reader.int(1));
    } else {
      authResponse = Buffer.from(reader.nulString(), 'utf8');
    }
    const database =
      this.clientFlags & CLIENT.CONNECT_WITH_DB && reader.remaining()
        ? reader.nulString()
        : '';
    const clientPlugin =
      this.clientFlags & CLIENT.PLUGIN_AUTH && reader.remaining()
        ? reader.nulString()
        : null;
    this.login = { user, database, clientPlugin };
    const options = this.server.options;
    const switchTo =
      options.switchTo ??
      (options.clearPassword ? 'mysql_clear_password' : undefined);
    if (switchTo) {
      this.phase = 'auth-switch';
      this.send(
        Buffer.concat([
          Buffer.from([0xfe]),
          nulString(switchTo),
          this.seed,
          Buffer.from([0])
        ])
      );
      return;
    }
    if (
      options.password !== undefined &&
      !authResponse.equals(nativePasswordAnswer(options.password, this.seed))
    ) {
      this.reply({
        error: {
          errno: 1045,
          sqlState: '28000',
          message: `Access denied for user '${user}'`
        }
      });
      this.socket.end();
      return;
    }
    this.server.logins.push({ ...this.login, clearPassword: null });
    this.phase = 'command';
    this.reply({});
  }

  private authSwitchResponse(payload: Buffer): void {
    const text = payload.toString('utf8');
    this.server.logins.push({
      ...this.login!,
      clearPassword: text.endsWith('\0') ? text.slice(0, -1) : text
    });
    this.phase = 'command';
    this.reply({});
  }

  private command(payload: Buffer): void {
    const code = payload[0];
    this.sequenceId = 1;
    if (code === 0x01) {
      this.socket.end();
      return;
    }
    if (code === 0x0e) {
      this.server.pings.push(this.id);
      const reply = this.server.options.onPing?.(this.id);
      this.reply(reply ?? {});
      return;
    }
    if (code === 0x03) {
      const sql = payload.subarray(1).toString('utf8');
      this.server.queries.push(sql);
      this.reply(this.server.options.onQuery?.(sql) ?? {});
      return;
    }
    this.reply({
      error: { errno: 1047, sqlState: '08S01', message: 'Unknown command' }
    });
  }

  private reply(reply: FakeReply): void {
    if ('hang' in reply) return;
    if ('error' in reply) {
      const errno = Buffer.alloc(2);
      errno.writeUInt16LE(reply.error.errno);
      this.send(
        Buffer.concat([
          Buffer.from([0xff]),
          errno,
          Buffer.from(`#${reply.error.sqlState}`, 'ascii'),
          Buffer.from(reply.error.message, 'utf8')
        ])
      );
      return;
    }
    if ('columns' in reply) {
      this.resultSet(reply);
      return;
    }
    const info = reply.info ?? '';
    this.send(
      Buffer.concat([
        Buffer.from([0x00]),
        lengthEncodedInt(reply.affectedRows ?? 0),
        lengthEncodedInt(reply.insertId ?? 0),
        Buffer.from([0x02, 0x00, 0x00, 0x00]),
        this.clientFlags & CLIENT.SESSION_TRACK
          ? lengthEncodedString(info)
          : Buffer.from(info, 'utf8')
      ])
    );
  }

  private resultSet(reply: Extract<FakeReply, { columns: unknown }>): void {
    const eof = Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00]);
    this.send(lengthEncodedInt(reply.columns.length));
    for (const column of reply.columns) {
      const binary = column.binary ?? !TEXT_TYPES.has(column.type);
      const charset = Buffer.alloc(2);
      charset.writeUInt16LE(binary ? CHARSET_BINARY : CHARSET_UTF8MB4);
      const flags = Buffer.alloc(2);
      flags.writeUInt16LE(binary ? BINARY_FLAG : 0);
      this.send(
        Buffer.concat([
          lengthEncodedString('def'),
          lengthEncodedString('fake'),
          lengthEncodedString('t'),
          lengthEncodedString('t'),
          lengthEncodedString(column.name),
          lengthEncodedString(column.name),
          Buffer.from([0x0c]),
          charset,
          Buffer.from([0xff, 0xff, 0x00, 0x00]),
          Buffer.from([column.type]),
          flags,
          Buffer.from([0x1f]),
          Buffer.alloc(2)
        ])
      );
    }
    this.send(eof);
    for (const row of reply.rows) {
      this.send(
        Buffer.concat(
          row.map((value) =>
            value === null ? Buffer.from([0xfb]) : lengthEncodedString(value)
          )
        )
      );
    }
    this.send(eof);
  }
}

export class FakeMysqlServer {
  readonly logins: FakeLogin[] = [];
  readonly queries: string[] = [];
  readonly pings: number[] = [];
  readonly connections: FakeConnection[] = [];
  private readonly server: net.Server;
  private nextId = 1;

  constructor(readonly options: FakeMysqlServerOptions = {}) {
    this.server = net.createServer((socket) => {
      this.connections.push(new FakeConnection(this.nextId++, socket, this));
    });
  }

  /** Resolves with the port it listens on, on 127.0.0.1. */
  async start(): Promise<number> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve)
    );
    return (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) connection.socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
