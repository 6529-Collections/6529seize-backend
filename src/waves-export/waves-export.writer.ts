import * as fs from 'node:fs';
import * as path from 'node:path';
import { once } from 'node:events';
import { createGzip } from 'node:zlib';
import { pythonJson } from './waves-export.json';

/** Files under OUT/raw, written whole (a temporary file, then renamed). */
export class RawDirectory {
  constructor(readonly root: string) {}

  path(...names: string[]): string {
    return path.join(this.root, ...names);
  }

  async ensure(...names: string[]): Promise<void> {
    await fs.promises.mkdir(this.path(...names), { recursive: true });
  }

  async save(name: string, value: unknown): Promise<void> {
    await this.ensure();
    const target = this.path(name);
    await fs.promises.writeFile(`${target}.tmp`, JSON.stringify(value), 'utf8');
    await fs.promises.rename(`${target}.tmp`, target);
  }

  async load<T>(name: string, fallback?: T): Promise<T> {
    try {
      return JSON.parse(await fs.promises.readFile(this.path(name), 'utf8'));
    } catch (error) {
      if (
        fallback !== undefined &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return fallback;
      }
      throw error;
    }
  }

  /**
   * A gzip file of JSON lines in Python's `json.dumps` form, one value a
   * line, written as they come.
   */
  async openJsonLines(...names: string[]): Promise<JsonLinesWriter> {
    await this.ensure(...names.slice(0, -1));
    return JsonLinesWriter.open(this.path(...names));
  }
}

export class JsonLinesWriter {
  private lines = 0;

  private constructor(
    private readonly target: string,
    private readonly gzip: ReturnType<typeof createGzip>,
    private readonly file: fs.WriteStream
  ) {}

  static open(target: string): JsonLinesWriter {
    const file = fs.createWriteStream(`${target}.tmp`);
    const gzip = createGzip();
    gzip.pipe(file);
    return new JsonLinesWriter(target, gzip, file);
  }

  get count(): number {
    return this.lines;
  }

  async write(value: unknown): Promise<void> {
    this.lines++;
    if (!this.gzip.write(`${pythonJson(value)}\n`, 'utf8')) {
      await once(this.gzip, 'drain');
    }
  }

  /** Finishes the file; with no line written, removes it. */
  async close(): Promise<void> {
    const closed = once(this.file, 'close');
    this.gzip.end();
    await closed;
    if (this.lines === 0) {
      await fs.promises.rm(`${this.target}.tmp`, { force: true });
      await fs.promises.rm(this.target, { force: true });
      return;
    }
    await fs.promises.rename(`${this.target}.tmp`, this.target);
  }
}
