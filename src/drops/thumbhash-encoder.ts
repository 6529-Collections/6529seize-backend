/*
 * ThumbHash encoder, ported to TypeScript from the reference implementation
 * (https://github.com/evanw/thumbhash, thumbhash.js `rgbaToThumbHash`).
 * The npm package is ESM-only, which the backend's CommonJS builds and Jest
 * cannot load, so the encoder lives here. Clients decode with the package.
 *
 * Copyright (c) 2023 Evan Wallace
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

type EncodedChannel = { dc: number; ac: number[]; scale: number };

function encodeChannel(
  channel: readonly number[],
  w: number,
  h: number,
  nx: number,
  ny: number
): EncodedChannel {
  let dc = 0;
  let scale = 0;
  const ac: number[] = [];
  const fx: number[] = [];
  for (let cy = 0; cy < ny; cy++) {
    for (let cx = 0; cx * ny < nx * (ny - cy); cx++) {
      let f = 0;
      for (let x = 0; x < w; x++)
        fx[x] = Math.cos((Math.PI / w) * cx * (x + 0.5));
      for (let y = 0; y < h; y++) {
        const fy = Math.cos((Math.PI / h) * cy * (y + 0.5));
        for (let x = 0; x < w; x++) f += channel[x + y * w] * fx[x] * fy;
      }
      f /= w * h;
      if (cx || cy) {
        ac.push(f);
        scale = Math.max(scale, Math.abs(f));
      } else {
        dc = f;
      }
    }
  }
  if (scale) {
    for (let i = 0; i < ac.length; i++) ac[i] = 0.5 + (0.5 / scale) * ac[i];
  }
  return { dc, ac, scale };
}

/**
 * Encodes an RGBA image (not premultiplied, at most 100×100) to ThumbHash
 * bytes, identically to the reference `rgbaToThumbHash`.
 */
export function rgbaToThumbHash(
  w: number,
  h: number,
  rgba: ArrayLike<number>
): Uint8Array {
  if (w > 100 || h > 100) throw new Error(`${w}x${h} doesn't fit in 100x100`);
  const { round, max } = Math;

  let avgR = 0;
  let avgG = 0;
  let avgB = 0;
  let avgA = 0;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const alpha = rgba[j + 3] / 255;
    avgR += (alpha / 255) * rgba[j];
    avgG += (alpha / 255) * rgba[j + 1];
    avgB += (alpha / 255) * rgba[j + 2];
    avgA += alpha;
  }
  if (avgA) {
    avgR /= avgA;
    avgG /= avgA;
    avgB /= avgA;
  }

  const hasAlpha = avgA < w * h;
  const lLimit = hasAlpha ? 5 : 7;
  const lx = max(1, round((lLimit * w) / max(w, h)));
  const ly = max(1, round((lLimit * h) / max(w, h)));
  const l: number[] = [];
  const p: number[] = [];
  const q: number[] = [];
  const a: number[] = [];

  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const alpha = rgba[j + 3] / 255;
    const r = avgR * (1 - alpha) + (alpha / 255) * rgba[j];
    const g = avgG * (1 - alpha) + (alpha / 255) * rgba[j + 1];
    const b = avgB * (1 - alpha) + (alpha / 255) * rgba[j + 2];
    l[i] = (r + g + b) / 3;
    p[i] = (r + g) / 2 - b;
    q[i] = r - g;
    a[i] = alpha;
  }

  const lum = encodeChannel(l, w, h, max(3, lx), max(3, ly));
  const yb = encodeChannel(p, w, h, 3, 3);
  const rg = encodeChannel(q, w, h, 3, 3);
  const alphaChannel = hasAlpha ? encodeChannel(a, w, h, 5, 5) : null;

  const isLandscape = w > h;
  const header24 =
    round(63 * lum.dc) |
    (round(31.5 + 31.5 * yb.dc) << 6) |
    (round(31.5 + 31.5 * rg.dc) << 12) |
    (round(31 * lum.scale) << 18) |
    ((hasAlpha ? 1 : 0) << 23);
  const header16 =
    (isLandscape ? ly : lx) |
    (round(63 * yb.scale) << 3) |
    (round(63 * rg.scale) << 9) |
    ((isLandscape ? 1 : 0) << 15);
  const hash = [
    header24 & 255,
    (header24 >> 8) & 255,
    header24 >> 16,
    header16 & 255,
    header16 >> 8
  ];
  const acStart = hasAlpha ? 6 : 5;
  let acIndex = 0;
  if (alphaChannel) {
    hash.push(
      round(15 * alphaChannel.dc) | (round(15 * alphaChannel.scale) << 4)
    );
  }
  const channels = alphaChannel
    ? [lum.ac, yb.ac, rg.ac, alphaChannel.ac]
    : [lum.ac, yb.ac, rg.ac];
  for (const ac of channels) {
    for (const f of ac) {
      const index = acStart + (acIndex >> 1);
      hash[index] =
        (hash[index] ?? 0) | (round(15 * f) << ((acIndex & 1) << 2));
      acIndex++;
    }
  }
  return new Uint8Array(hash);
}
