import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  audioTrack,
  goProVideo,
  iphoneVideo,
  videoTrack
} from './fixtures/synthetic-video-fixtures';
import { readBoxes } from './iso-boxes';
import { stripVideoMetadataFile } from './video-metadata-strip';
import { verifyVideoStrip } from './video-strip-verification';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'video-verify-test-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function stripped(input: Buffer, name: string) {
  const inputPath = join(directory, name);
  const outputPath = join(directory, `${name}.out`);
  await writeFile(inputPath, input);
  const result = await stripVideoMetadataFile(inputPath, outputPath);
  expect(result.kind).toBe('stripped');
  return { inputPath, outputPath, output: await readFile(outputPath) };
}

async function verifyAgainst(inputPath: string, output: Buffer) {
  const path = join(
    directory,
    `tampered-${Math.random().toString(36).slice(2)}`
  );
  await writeFile(path, output);
  return verifyVideoStrip(inputPath, path);
}

function topBox(bytes: Buffer, type: string) {
  return readBoxes(bytes, 0, bytes.length).find((box) => box.type === type)!;
}

describe('verifyVideoStrip', () => {
  it('accepts a correct strip and reports each track', async () => {
    const { inputPath, outputPath } = await stripped(goProVideo(), 'gopro');
    const verification = await verifyVideoStrip(inputPath, outputPath);
    expect(verification).toMatchObject({
      ok: true,
      tracks: [
        { handler: 'vide', codecs: ['avc1'] },
        { handler: 'soun', codecs: ['mp4a'] }
      ]
    });
  });

  it('rejects changed sample bytes', async () => {
    const { inputPath, output } = await stripped(iphoneVideo(), 'iphone');
    const mdat = topBox(output, 'mdat');
    output[mdat.payloadStart + 10] ^= 0xff;
    expect(await verifyAgainst(inputPath, output)).toEqual({
      ok: false,
      reason: 'track 1 sample bytes changed'
    });
  });

  it('rejects an unstripped file', async () => {
    const input = goProVideo();
    const path = join(directory, 'original');
    await writeFile(path, input);
    const verification = await verifyVideoStrip(path, path);
    expect(verification.ok).toBe(false);
  });

  it('rejects a changed display matrix', async () => {
    const { inputPath } = await stripped(iphoneVideo(), 'rotated');
    // Same samples and tables, but the video track is not rotated.
    const { output: unrotated } = await stripped(
      iphoneVideo({ tracks: [videoTrack({ codec: 'hvc1' }), audioTrack()] }),
      'unrotated'
    );
    expect(await verifyAgainst(inputPath, unrotated)).toEqual({
      ok: false,
      reason: 'track 1 header (matrix, size or duration) changed'
    });
  });

  it('rejects media data that no sample uses', async () => {
    const { inputPath, output } = await stripped(iphoneVideo(), 'padded');
    const mdat = topBox(output, 'mdat');
    const padded = Buffer.concat([output, Buffer.from('leftover')]);
    padded.writeUInt32BE(padded.length - mdat.start, mdat.start);
    const verification = await verifyAgainst(inputPath, padded);
    expect(verification).toMatchObject({ ok: false });
    expect(!verification.ok && verification.reason).toContain('unreferenced');
  });

  it('rejects remaining creation times', async () => {
    const { inputPath, output } = await stripped(iphoneVideo(), 'timed');
    const at = output.indexOf(Buffer.from('mvhd', 'latin1'));
    output.writeUInt32BE(3797407200, at + 8);
    expect(await verifyAgainst(inputPath, output)).toEqual({
      ok: false,
      reason: 'metadata remains: mvhd has times'
    });
  });
});
