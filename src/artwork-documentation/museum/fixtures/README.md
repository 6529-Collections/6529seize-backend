# Museum capture and archival fixtures

These are test inputs, not live artist submissions, scanner receipts, signed
provenance, accession records, or evidence of an external museum ingest.

`media-accounts.ts` supplies all ten media-module accounts. `museum-corpus.ts`
writes every required baseline and selected-media answer through the production
field validator. The corpus also covers photography + HTML + interaction and an
installation with photography, audio and spatial components. Its original bytes
are synthetic format vectors; the test ready-asset snapshots stand in for the
independently tested upload pipeline and contain no claimed malware-scan result.

`synthetic-blue.mp4` is a generated one-second 64 × 64 blue video using the
repository's FFmpeg binary. `synthetic-installation.zip` is an uncompressed,
fixed-timestamp archive containing a clearly labeled test README. No archive or
artwork code is executed during corpus tests. Other tiny vectors are generated
deterministically in the fixture builder.

The user supplied `an-alteration.txt` and `an-alteration-preview.png` as the
best-practice sample on 12 September 2026. They are byte-for-byte copies:

| File                      | SHA-256                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| an-alteration.txt         | 51348533f11d1b27381f07971ea9a9aeff024ede39b02ad6b8509ebb3810447e |
| an-alteration-preview.png | 4fe97f0b02115df2a1b084599c774652b7a23990a0735bf5a2e5ac6dcc917b79 |

The fixture retains the entire source and each complete section, and maps the
caption, statement, production account, printing instructions, full custom
written interview, named materials, physical objects and dimensions separately.
The original writing is not silently corrected. Its inconsistent print-location
accounts remain attributed statements; no custody event is fabricated. Only the
actual text and PNG bytes are received in the fixture. The named TIFF, IIQ,
working projects, ICC profile, presets, site study, notebook scans, proofing notes
and separate interview attachment remain descriptions of expected material.
The PNG is a preview, not the named master or a canonical final-file selection.

`museum-corpus.test.ts` checks actual field schemas, conditional media answers,
upload-format policy, source coverage, Linked Art class validation, LIDO/PREMIS
presence and complete OCFL/BagIt reconstruction with byte fixity. Exact source
paragraphs, original file bytes and declared-versus-received distinctions survive
the round trip. No user permission, authentication capability, legal title or
signature verification is restored from an imported dossier.

The canonical text representation uses NFC and LF, as all existing artist
answers do. The source attachment keeps its original CRLF bytes and digest.

| Capture case                                 | Media account                          | Linked Art work class   |
| -------------------------------------------- | -------------------------------------- | ----------------------- |
| Photography                                  | `process.photography`                  | VisualItem (E36)        |
| Digital art                                  | `process.digital_art`                  | VisualItem (E36)        |
| Video                                        | `process.video`                        | InformationObject (E73) |
| Audio                                        | `process.audio`                        | InformationObject (E73) |
| HTML                                         | `process.html`                         | InformationObject (E73) |
| Generative art                               | `process.generative`                   | InformationObject (E73) |
| Interactive art                              | `process.interactive`                  | InformationObject (E73) |
| Spatial work                                 | `process.spatial`                      | InformationObject (E73) |
| Text                                         | `process.text`                         | LinguisticObject (E33)  |
| Installation                                 | `process.installation`                 | InformationObject (E73) |
| Photography + HTML + interaction             | All three accounts                     | InformationObject (E73) |
| Installation + photography + audio + spatial | All four accounts                      | InformationObject (E73) |
| AN ALTERATION                                | Photography and complete source record | VisualItem (E36)        |

Every case retains all source fields in the portable record. Received files
project as DigitalObject (D1), physical objects as HumanMadeObject (E22), and
separately authored texts as LinguisticObject (E33). LIDO carries descriptions,
scoped dimensions and attributed events; PREMIS carries original file fixity,
reported characterization, preservation provenance and scoped rights accounts.
Media-specific technical detail without a safe standard correspondence remains
explicitly covered in the source sidecar, rather than being silently dropped.

Run `scripts/write-museum-corpus.ts` through the repository
TypeScript wrapper and `python scripts/validate-museum-corpus.py
.museum-corpus-fixtures`. The writer uses that fixed, ignored directory beneath
the repository. The independent validator checks the locked official LIDO
and PREMIS XSD closure for all 26 XML projections, the 13 IIIF manifests against
the pinned official schema, and all output digests.
This is supported-subset export evidence, not certification by the standards
owners, a deployed scanning test, or a claim of complete external API conformance.
