Synthetic 24×12 codec regression fixtures generated with Sharp 0.35.3.
The JPEG has EXIF orientation 6 and a synthetic camera make. The GIF has two
frames (red and green), delays of 80/160 ms and loop count 2. No user media or
personal metadata is included. Keep these source bytes stable across upgrades
so decoding and animation checks exercise inputs from the preceding codec.

The MP4 is the synthetic blue video from the museum test corpus. It contains no
artist material and exercises the separately packaged MP4 parser. SHA-256:
`f2979c5cdad603338e759b42671270d3d073abccb03cb5058a862c98389cdced`.
