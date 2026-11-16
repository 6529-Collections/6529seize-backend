import { extensionMismatch, sniffImageContainer } from './image-container';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const HEIC = Buffer.from('\0\0\0\x18ftypheic\0\0\0\0', 'latin1');

describe('extensionMismatch', () => {
  it.each([
    ['drops/a/photo.jpg', JPEG],
    ['drops/a/photo.JPEG', JPEG],
    ['drops/a/photo.jfif', JPEG],
    ['drops/a/image.png', PNG],
    ['drops/a/no-extension', PNG],
    ['drops/a.b/no-extension', PNG],
    ['drops/a/trailing.', PNG],
    ['drops/a/.hidden', PNG],
    ['waves/a/photo.heic', HEIC]
  ])('accepts %s', (key, bytes) => {
    expect(extensionMismatch(key, sniffImageContainer(bytes))).toBeNull();
  });

  it.each([
    ['drops/a/photo.jpg', PNG, { extension: 'jpg', container: 'png' }],
    ['drops/a/photo.JPG', HEIC, { extension: 'jpg', container: 'heif' }],
    ['drops/a/image.png', JPEG, { extension: 'png', container: 'jpeg' }],
    ['drops/a/image.webp', JPEG, { extension: 'webp', container: 'jpeg' }]
  ])('reports %s holding another container', (key, bytes, expected) => {
    expect(extensionMismatch(key, sniffImageContainer(bytes))).toEqual(
      expected
    );
  });
});
