jest.mock('sharp', () => ({
  __esModule: true,
  default: jest.fn()
}));

jest.mock('imagescript', () => ({
  GIF: {
    decode: jest.fn()
  }
}));

jest.mock('@/logging', () => {
  const logger = {
    warn: jest.fn()
  };
  return {
    Logger: {
      get: jest.fn(() => logger)
    }
  };
});

import Sharp from 'sharp';
import { Logger } from '@/logging';
import { resizeImageBufferToHeight } from '@/media/image-resize';

const imagescript = require('imagescript');
type SharpInstance = ReturnType<typeof Sharp>;

describe('resizeImageBufferToHeight', () => {
  const buffer = Buffer.from('image');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses ImageScript for GIFs when it can process the image', async () => {
    const resize = jest.fn();
    const encode = jest.fn().mockResolvedValue(Buffer.from('imagescript-gif'));
    imagescript.GIF.decode.mockResolvedValue({
      width: 800,
      height: 400,
      resize,
      encode
    });

    const result = await resizeImageBufferToHeight({
      buffer,
      height: 200,
      toWebp: false
    });

    expect(result).toEqual(Buffer.from('imagescript-gif'));
    expect(resize).toHaveBeenCalledWith(400, 200);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(Sharp).not.toHaveBeenCalled();
  });

  it('keeps the direct Sharp WebP path unchanged', async () => {
    const toBuffer = jest.fn().mockResolvedValue(Buffer.from('sharp-webp'));
    const webp = jest.fn().mockReturnValue({ toBuffer });
    const resize = jest.fn().mockReturnValue({ webp });
    jest.mocked(Sharp).mockReturnValue({ resize } as unknown as SharpInstance);

    const result = await resizeImageBufferToHeight({
      buffer,
      height: 1000,
      toWebp: true
    });

    expect(result).toEqual(Buffer.from('sharp-webp'));
    expect(Sharp).toHaveBeenCalledWith(buffer);
    expect(resize).toHaveBeenCalledWith({ height: 1000 });
    expect(webp).toHaveBeenCalledTimes(1);
    expect(imagescript.GIF.decode).not.toHaveBeenCalled();
  });

  it('falls back to animated Sharp when ImageScript fails', async () => {
    const toBuffer = jest.fn().mockResolvedValue(Buffer.from('sharp-gif'));
    const gif = jest.fn().mockReturnValue({ toBuffer });
    const resize = jest.fn().mockReturnValue({ gif });
    jest.mocked(Sharp).mockReturnValue({ resize } as unknown as SharpInstance);
    imagescript.GIF.decode.mockRejectedValue(new Error('unreachable'));

    const result = await resizeImageBufferToHeight({
      buffer,
      height: 450,
      toWebp: false
    });

    expect(result).toEqual(Buffer.from('sharp-gif'));
    expect(Sharp).toHaveBeenCalledWith(buffer, { animated: true });
    expect(resize).toHaveBeenCalledWith({ height: 450 });
    expect(gif).toHaveBeenCalledTimes(1);
    expect(Logger.get('IMAGE_RESIZE').warn).toHaveBeenCalledWith(
      '[GIF RESIZE FALLBACK] ImageScript failed; retrying with Sharp [height=450]',
      expect.objectContaining({ message: 'unreachable' })
    );
  });

  it('propagates the error when ImageScript and Sharp both fail', async () => {
    const sharpError = new Error('sharp failed');
    const toBuffer = jest.fn().mockRejectedValue(sharpError);
    const gif = jest.fn().mockReturnValue({ toBuffer });
    const resize = jest.fn().mockReturnValue({ gif });
    jest.mocked(Sharp).mockReturnValue({ resize } as unknown as SharpInstance);
    imagescript.GIF.decode.mockRejectedValue(new Error('unreachable'));

    await expect(
      resizeImageBufferToHeight({ buffer, height: 60, toWebp: false })
    ).rejects.toBe(sharpError);
  });
});
