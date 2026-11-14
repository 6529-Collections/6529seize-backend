import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { stripVideoMetadataVerified } from './verified-video-strip';
import { VideoMetadataFinding } from './video-metadata-policy';

const run = promisify(execFile);

/** The ffmpeg binary the backend already installs for its media loops. */
function bundledFfmpeg(): string | null {
  try {
    return (require('@ffmpeg-installer/ffmpeg') as { path: string }).path;
  } catch {
    return null;
  }
}

const ffmpeg = bundledFfmpeg();
// The root install provides ffmpeg on CI and developer machines alike; only
// a local platform without an @ffmpeg-installer build skips these real
// files. On CI a missing binary fails the suite instead of skipping it.
const describeWithFfmpeg = ffmpeg || process.env.CI ? describe : describe.skip;

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'video-strip-real-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function ffmpegRun(
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return run(ffmpeg!, ['-hide_banner', '-nostdin', ...args], {
    maxBuffer: 16 * 1024 * 1024
  });
}

/**
 * One second of test picture and tone, encoded with the given options. A
 * display rotation is only written when streams are copied, so `remux`
 * options apply in a second, stream-copying pass.
 */
async function encode(
  output: string,
  options: string[],
  remux: string[] = []
): Promise<void> {
  const encoded = remux.length ? `${output}.encoded${extname(output)}` : output;
  await ffmpegRun([
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=96x64:rate=15:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100:duration=1',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-metadata',
    'creation_time=2024-05-01T10:00:00Z',
    ...options,
    encoded
  ]);
  if (!remux.length) return;
  await ffmpegRun([
    '-loglevel',
    'error',
    '-i',
    encoded,
    '-map',
    '0',
    '-c',
    'copy',
    ...remux,
    output
  ]);
}

/** ffmpeg's description lines about display rotation. */
function rotationLines(description: string): string[] {
  return description
    .split(/\r?\n/)
    .filter((line) => /rotate|displaymatrix/.test(line))
    .map((line) => line.trim());
}

/** Decoded frames or audio, hashed per frame with their timestamps. */
async function decodedFrames(path: string, stream: 'v' | 'a'): Promise<string> {
  const { stdout } = await ffmpegRun([
    '-loglevel',
    'error',
    '-i',
    path,
    '-map',
    `0:${stream}`,
    '-f',
    'framemd5',
    '-'
  ]);
  return stdout;
}

/** What ffmpeg reports about the container and streams. */
async function describeFile(path: string): Promise<string> {
  // `ffmpeg -i` without an output exits 1 after printing the description.
  const result = await ffmpegRun(['-i', path]).catch(
    (error: { stderr?: string }) => ({ stderr: error.stderr ?? '' })
  );
  return result.stderr;
}

async function contains(path: string, text: string): Promise<boolean> {
  return (await readFile(path)).includes(Buffer.from(text, 'latin1'));
}

async function stripAndCompare(input: string) {
  const output = join(directory, 'stripped');
  const result = await stripVideoMetadataVerified(input, output);
  expect(result.kind).toBe('stripped');
  for (const stream of ['v', 'a'] as const) {
    expect(await decodedFrames(output, stream)).toBe(
      await decodedFrames(input, stream)
    );
  }
  return { result, output, description: await describeFile(output) };
}

describeWithFfmpeg('stripping real encoder output', () => {
  it('keeps H.264/AAC frames and rotation while removing 3GPP loci location', async () => {
    const input = join(directory, 'camera.mp4');
    await encode(
      input,
      ['-c:v', 'libx264', '-preset', 'ultrafast'],
      [
        '-metadata',
        'location=+37.4219-122.0840/',
        '-metadata',
        'creation_time=2024-05-01T10:00:00Z',
        '-metadata:s:v:0',
        'rotate=90'
      ]
    );
    expect(await contains(input, 'loci')).toBe(true);
    const rotation = rotationLines(await describeFile(input));
    expect(rotation.length).toBeGreaterThan(0);

    const { result, output, description } = await stripAndCompare(input);

    expect(result).toMatchObject({
      findings: expect.arrayContaining([
        VideoMetadataFinding.LOCATION,
        VideoMetadataFinding.CAPTURE_TIME
      ])
    });
    expect(await contains(output, 'loci')).toBe(false);
    expect(await contains(output, 'Lavf')).toBe(false);
    expect(description).not.toMatch(/location|creation_time|encoder/);
    expect(rotationLines(description)).toEqual(rotation);
    expect(description).toMatch(/Video: h264/);
    expect(description).toMatch(/Audio: aac/);
  }, 60_000);

  it('removes QuickTime ©xyz location', async () => {
    const input = join(directory, 'phone.mov');
    await encode(input, [
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-metadata',
      'location=+37.4219-122.0840/'
    ]);
    expect(await contains(input, '©xyz')).toBe(true);

    const { output, description } = await stripAndCompare(input);

    expect(await contains(output, '©xyz')).toBe(false);
    expect(await contains(output, '+37.4219')).toBe(false);
    expect(description).not.toMatch(/location|creation_time/);
  }, 60_000);

  it('keeps HEVC/AAC frames while removing Apple mdta location, make and model keys', async () => {
    const input = join(directory, 'iphone.mov');
    await encode(input, [
      '-c:v',
      'libx265',
      '-x265-params',
      'log-level=error',
      '-preset',
      'ultrafast',
      '-tag:v',
      'hvc1',
      '-movflags',
      'use_metadata_tags',
      '-metadata',
      'com.apple.quicktime.location.ISO6709=+37.3349-122.0090+010.000/',
      '-metadata',
      'com.apple.quicktime.make=Apple',
      '-metadata',
      'com.apple.quicktime.model=iPhone 15 Pro'
    ]);
    expect(await contains(input, 'com.apple.quicktime.location.ISO6709')).toBe(
      true
    );

    const { result, output, description } = await stripAndCompare(input);

    expect(result).toMatchObject({
      findings: expect.arrayContaining([
        VideoMetadataFinding.LOCATION,
        VideoMetadataFinding.DEVICE
      ])
    });
    expect(await contains(output, 'com.apple.quicktime')).toBe(false);
    expect(await contains(output, 'iPhone 15 Pro')).toBe(false);
    expect(await contains(output, 'hvc1')).toBe(true);
    expect(description).toMatch(/Video: hevc/);
    expect(description).not.toMatch(/location|creation_time|com\.apple/);
  }, 60_000);
});
