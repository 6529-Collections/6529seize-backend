# Selected PRONOM source snapshots

The JSON files are unchanged official records from `nationalarchives/pronom`, commit `e729b24f9ecca4722d6e3fd73703d8ec4b0c5724`, under `signatures/fmt/{number}.json`. Its MIT licence accompanies them in `LICENCE`.

`artwork-assets.pronom.ts` binds each selected signature to the SHA-256 of these exact bytes. Tests check those hashes and signature identifiers. GIF and JFIF matching includes the required trailer, and WebP variants use their different container signatures. Matches mean the selected PRONOM signature matched; they do not claim a complete DROID priority-resolution run or complete format validity. Other formats remain explicitly unidentified by PRONOM until a supported identification adapter supplies evidence.

No request fetches live registry definitions while processing an artist's file. Updating definitions requires a reviewed snapshot/code/test change.

The local `.gitattributes` prevents checkout newline conversion for the hashed JSON snapshots. Do not format or normalize these source files.
