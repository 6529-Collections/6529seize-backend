import * as fs from 'node:fs';
import * as path from 'node:path';
import { once } from 'node:events';
import { createGzip } from 'node:zlib';
import { fetchForm, pythonJson } from './waves-export.json';

/**
 * Files under OUT/raw, each written whole: to a temporary file, renamed into
 * place only when complete, so a file that exists is a finished one.
 */
export class RawDirectory {
  constructor(readonly root: string) {}

  path(...names: string[]): string {
    return path.join(this.root, ...names);
  }

  async ensure(...names: string[]): Promise<void> {
    await fs.promises.mkdir(this.path(...names), { recursive: true });
  }

  exists(...names: string[]): boolean {
    return fs.existsSync(this.path(...names));
  }

  /** A JSON file, its values in the fetch stage's form (fetchForm). */
  async save(name: string, value: unknown): Promise<void> {
    await this.ensure();
    const target = this.path(name);
    await fs.promises.writeFile(
      `${target}.tmp`,
      JSON.stringify(fetchForm(value)),
      'utf8'
    );
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

  /** Removes a finished file (a wave read again from the start). */
  async remove(...names: string[]): Promise<void> {
    await fs.promises.rm(this.path(...names), { force: true });
  }
}

export class JsonLinesWriter {
  private lines = 0;
  private finished = false;

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

  /**
   * Finishes the file and puts it in place; with no line written there is
   * no file (as the fetch stage writes none for a wave without drops).
   */
  async commit(): Promise<void> {
    await this.end();
    if (this.lines === 0) {
      await fs.promises.rm(this.target, { force: true });
      await fs.promises.rm(`${this.target}.tmp`, { force: true });
      return;
    }
    await fs.promises.rename(`${this.target}.tmp`, this.target);
  }

  /** Drops what was written: the file is not put in place. */
  async abort(): Promise<void> {
    await this.end();
    await fs.promises.rm(`${this.target}.tmp`, { force: true });
  }

  private async end(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const closed = once(this.file, 'close');
    this.gzip.end();
    await closed;
  }
}
