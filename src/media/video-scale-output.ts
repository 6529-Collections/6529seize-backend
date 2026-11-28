import { PassThrough } from 'node:stream';

/** The parts of a fluent-ffmpeg command that collecting its output needs. */
export interface VideoScaleCommand {
  on(event: 'error', listener: (err: unknown) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  pipe(stream: NodeJS.WritableStream, options?: { end?: boolean }): unknown;
}

/**
 * Runs `command` and resolves with its whole output, only once ffmpeg has
 * exited successfully and has written something. ffmpeg can close its output
 * stream before it reports a failure (a source that answers 404, say), so the
 * output is never complete before the command's own `end`; a failure at any
 * point rejects, and so does a run that wrote nothing.
 */
export function collectVideoScaleOutput(
  command: VideoScaleCommand,
  label: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let outputEnded = false;
    let commandEnded = false;
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const finish = () => {
      if (settled || !outputEnded || !commandEnded) return;
      settled = true;
      if (bytes === 0) {
        reject(new Error(`ffmpeg produced no output for ${label}`));
        return;
      }
      resolve(Buffer.concat(chunks, bytes));
    };
    const output = new PassThrough();
    output.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      bytes += chunk.length;
    });
    output.on('end', () => {
      outputEnded = true;
      finish();
    });
    output.on('error', fail);
    command.on('error', fail);
    command.on('end', () => {
      commandEnded = true;
      finish();
    });
    command.pipe(output, { end: true });
  });
}

/**
 * An error safe to log when ffmpeg read a presigned S3 URL: ffmpeg puts the
 * source URL in its messages, and the query string carries the signature.
 */
export function withoutSignedQuery(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(message.replace(/\?X-Amz-[^\s'"]*/g, '?[signed]'));
}
