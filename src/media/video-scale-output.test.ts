import { EventEmitter } from 'node:events';
import {
  collectVideoScaleOutput,
  withoutSignedQuery
} from '@/media/video-scale-output';

type Step =
  | { write: string }
  | { endOutput: true }
  | { command: 'end' }
  | { command: 'error'; message: string };

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A fluent-ffmpeg command stand-in that plays `steps` once piped, one event
 * loop turn apart, so each step's events (an ended output stream emits `end`
 * on a later tick) have fired before the next step runs.
 */
function fakeCommand(steps: Step[]) {
  const command = new EventEmitter() as EventEmitter & {
    pipe: (stream: NodeJS.WritableStream) => void;
  };
  command.pipe = (stream: NodeJS.WritableStream) => {
    void (async () => {
      for (const step of steps) {
        await nextTurn();
        if ('write' in step) stream.write(Buffer.from(step.write));
        else if ('endOutput' in step) stream.end();
        else if (step.command === 'end') command.emit('end');
        else command.emit('error', new Error(step.message));
      }
    })();
  };
  return command;
}

describe('collectVideoScaleOutput', () => {
  it('resolves with everything ffmpeg wrote once it exits cleanly', async () => {
    await expect(
      collectVideoScaleOutput(
        fakeCommand([
          { write: 'abc' },
          { write: 'def' },
          { endOutput: true },
          { command: 'end' }
        ]),
        'videos/x/scaledx750/1.MP4'
      )
    ).resolves.toEqual(Buffer.from('abcdef'));
  });

  it('rejects when ffmpeg fails after its output stream has already ended', async () => {
    // Meme #579 on 2026-11-25: the source answered 404, ffmpeg closed its
    // output empty and only then reported the failure.
    await expect(
      collectVideoScaleOutput(
        fakeCommand([
          { endOutput: true },
          {
            command: 'error',
            message:
              'ffmpeg exited with code 1: https://arweave.net/x: Server returned 404 Not Found'
          }
        ]),
        'videos/x/scaledx750/579.MP4'
      )
    ).rejects.toThrow('Server returned 404 Not Found');
  });

  it('rejects a clean exit that wrote nothing', async () => {
    await expect(
      collectVideoScaleOutput(
        fakeCommand([{ endOutput: true }, { command: 'end' }]),
        'videos/x/scaledx750/2.MP4'
      )
    ).rejects.toThrow(
      'ffmpeg produced no output for videos/x/scaledx750/2.MP4'
    );
  });

  it('rejects a failure in the middle of the output', async () => {
    await expect(
      collectVideoScaleOutput(
        fakeCommand([
          { write: 'abc' },
          { command: 'error', message: 'Conversion failed!' },
          { endOutput: true }
        ]),
        'videos/x/scaledx750/3.MP4'
      )
    ).rejects.toThrow('Conversion failed!');
  });
});

describe('withoutSignedQuery', () => {
  it('drops the signature from a presigned URL in an ffmpeg message', () => {
    const err = new Error(
      'ffmpeg exited with code 1: https://bucket.s3.amazonaws.com/videos/a/1.MP4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc123: Server returned 403 Forbidden'
    );
    expect(withoutSignedQuery(err).message).toBe(
      'ffmpeg exited with code 1: https://bucket.s3.amazonaws.com/videos/a/1.MP4?[signed] Server returned 403 Forbidden'
    );
  });
});
