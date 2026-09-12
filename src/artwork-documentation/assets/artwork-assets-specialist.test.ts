import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { characterizeAssetHeader } from './artwork-assets.characterization';
import {
  inspectAssetHeader,
  hashAssetStream
} from './artwork-assets.inspection';
import {
  identifyPronomFormat,
  PRONOM_SIGNATURES
} from './artwork-assets.pronom';
import {
  requirePublicationAsset,
  validateStartUpload
} from './artwork-assets.policy';

describe('composable specialist material policy', () => {
  it.each([
    ['html', 'html'],
    ['video', 'mp4'],
    ['audio', 'wav'],
    ['spatial', 'glb'],
    ['text', 'epub'],
    ['generative', 'js'],
    ['digital_art', 'svg']
  ])(
    'allows %s final media only with a server-derived applicable profile',
    (profile, extension) => {
      const input = {
        filename: `work.${extension}`,
        size_bytes: 1024,
        declared_mime: 'application/octet-stream',
        role: 'artwork_final' as const,
        intended_visibility: 'public_record' as const
      };
      expect(validateStartUpload(input, { mediaProfiles: [profile] })).toBe(
        extension
      );
      expect(() => validateStartUpload(input)).toThrow();
      expect(() =>
        validateStartUpload(input, { mediaProfiles: ['photography'] })
      ).toThrow('invalid_format_for_role');
    }
  );
  it('combines media and makes original/project contributions explicitly public without changing legacy intake', () => {
    expect(
      validateStartUpload(
        {
          filename: 'index.html',
          size_bytes: 100,
          declared_mime: 'text/html',
          role: 'artwork_final',
          intended_visibility: 'public_record'
        },
        { mediaProfiles: ['photography', 'html', 'interactive'] }
      )
    ).toBe('html');
    const source = {
      role: 'camera_original',
      intended_visibility: 'public_record'
    };
    expect(() =>
      requirePublicationAsset({ publicationOnly: true }, source)
    ).toThrow();
    expect(() =>
      requirePublicationAsset(
        { publicationOnly: true, mediaProfiles: ['photography'] },
        source
      )
    ).not.toThrow();
    expect(() =>
      requirePublicationAsset(
        { publicationOnly: true, mediaProfiles: ['photography'] },
        { ...source, intended_visibility: 'restricted' }
      )
    ).toThrow('publication_visibility_required');
  });
  it('applies website PDF capacity before transferring a large file', () => {
    expect(() =>
      validateStartUpload(
        {
          filename: 'book.pdf',
          size_bytes: 26 * 1024 ** 2,
          declared_mime: 'application/pdf',
          role: 'publication',
          intended_visibility: 'public_record'
        },
        { mediaProfiles: ['text'] }
      )
    ).toThrow('pdf_size_limit');
  });
});

describe('byte-backed specialist characterization', () => {
  it('recognizes Phase One TIFF containers without asserting complete RAW parsing', () => {
    expect(
      inspectAssetHeader(Buffer.from('II*\0\x08\0\0\0'), 'iiq')
    ).toMatchObject({
      detected_mime: 'image/x-phaseone-iiq',
      inspection_status: 'unsupported'
    });
  });
  it('reads ICC header characteristics and rejects contradictory declared length', () => {
    const icc = Buffer.alloc(128);
    icc.writeUInt32BE(128);
    icc[8] = 4;
    icc[9] = 0x40;
    icc.write('mntrRGB XYZ ', 12, 'ascii');
    icc.write('acsp', 36, 'ascii');
    expect(inspectAssetHeader(icc, 'icc').detected_mime).toBe(
      'application/vnd.iccprofile'
    );
    expect(
      characterizeAssetHeader(icc, 'icc', 128, 'test-digest').properties
    ).toMatchObject({
      profile_version: '4.4.0',
      color_space: 'RGB',
      connection_space: 'XYZ'
    });
    expect(() =>
      characterizeAssetHeader(icc, 'icc', 129, 'test-digest')
    ).toThrow('INVALID_COLOR_PROFILE_SIZE');
  });
  it('extracts PCM duration, bit depth, channels and sample rate from a complete WAV fixture', () => {
    const wav = Buffer.alloc(44 + 16);
    wav.write('RIFF');
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(48000, 24);
    wav.writeUInt32LE(192000, 28);
    wav.writeUInt16LE(4, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(16, 40);
    expect(
      characterizeAssetHeader(wav, 'wav', wav.length, 'test-digest').properties
    ).toMatchObject({
      channels: 2,
      bit_depth: 16,
      sample_rate_hz: 48000,
      duration_seconds: 16 / 192000
    });
  });
  it.each(['svg', 'xml', 'cos', 'costyle', 'cop'])(
    'rejects external entities across streamed chunks in %s',
    async (extension) => {
      const chunks = [
        Buffer.from('<?xml?><!DOC'),
        Buffer.from('TYPE root [<!ENTITY x SYSTEM "file:///etc/passwd">]>')
      ];
      await expect(
        hashAssetStream(
          Readable.from(chunks),
          chunks.reduce((sum, chunk) => sum + chunk.length, 0),
          extension,
          new AbortController().signal
        )
      ).rejects.toThrow('UNSAFE_XML_DECLARATION');
    }
  );
  it('preserves active source bytes as inert data and rejects spoofed specialist signatures', async () => {
    const html = Buffer.from(
      '<!doctype html><html><script>throw new Error("never execute");</script></html>'
    );
    const hashed = await hashAssetStream(
      Readable.from([html]),
      html.length,
      'html',
      new AbortController().signal
    );
    expect(hashed.sha256).toBe(createHash('sha256').update(html).digest('hex'));
    expect(inspectAssetHeader(hashed.prefix, 'html').detected_mime).toBe(
      'text/html'
    );
    expect(() => inspectAssetHeader(html, 'glb')).toThrow(
      'FILE_SIGNATURE_MISMATCH'
    );
  });
});

describe('pinned PRONOM evidence', () => {
  it('keeps byte-exact official source snapshots matching every recorded checksum and signature', () => {
    for (const item of PRONOM_SIGNATURES) {
      const bytes = readFileSync(
        join(
          __dirname,
          'pronom-source',
          `${item.identifier.replace('/', '-')}.json`
        )
      );
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        item.source_sha256
      );
      const record = JSON.parse(bytes.toString('utf8'));
      expect(
        record.internalSignatures.some(
          (signature: { signatureID: number }) =>
            signature.signatureID === item.signature_id
        )
      ).toBe(true);
    }
  });
  it('distinguishes actual WebP versions and refuses a missing GIF trailer', () => {
    const lossy = Buffer.from('RIFFxxxxWEBPVP8 ');
    const lossless = Buffer.from('RIFFxxxxWEBPVP8L');
    expect(identifyPronomFormat(lossy, lossy)).toMatchObject({
      status: 'signature_match',
      identifier: 'fmt/566'
    });
    expect(identifyPronomFormat(lossless, lossless)).toMatchObject({
      identifier: 'fmt/567'
    });
    expect(
      identifyPronomFormat(Buffer.from('GIF89a'), Buffer.from('broken'))
    ).toMatchObject({ status: 'unidentified' });
    expect(
      identifyPronomFormat(Buffer.from('GIF89a'), Buffer.from(';'))
    ).toMatchObject({ identifier: 'fmt/4' });
  });
});
