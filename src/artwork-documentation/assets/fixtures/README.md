# Public technical fixtures

These are SDK test assets, not submitted artworks or artist provenance. No private keys or signing credentials are included. The MIT licence is retained in `LICENSE-c2pa`.

Source: `https://github.com/contentauth/c2pa-js`, immutable commit `10e1989f8fe83670c4bd34ca4e558e01cd3ebcd0`.

| Local file        | Source path                                 | SHA-256                                                          |
| ----------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| c2pa-unsigned.jpg | packages/c2pa-node/tests/fixtures/A.jpg     | f999fd78bfe8a83c96e468a078830ba94485bc1bc6fd086fb94a43bd29dd0f23 |
| c2pa-signed.jpg   | packages/c2pa-node/tests/fixtures/CA.jpg    | e71bff58fc57640803e6e65f7534e2fb0c2f99018c85276cc14b30f04427cc76 |
| c2pa-cloud.jpg    | packages/c2pa-node/tests/fixtures/cloud.jpg | e6ad9f51be5bb83f137322a3f260b5881738e3528aee208727e75b6daaba6092 |
| dash-init.mp4     | packages/c2pa-web/test/assets/dashinit.mp4  | 98932f75cc3f796ce77bbb3b7306c9e09756b099d7fd4335219eec73a9ea0bf8 |

The fragmented MP4 fixture tests actual container metadata, not completion of a full audiovisual artwork. Signed credentials in the SDK fixture are test claims; their presence never establishes a museum's trust in the signer.
