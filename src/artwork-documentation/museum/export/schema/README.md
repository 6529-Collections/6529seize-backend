# Linked Art draft archival profile

`linked-art-context.json` is an unchanged byte snapshot retrieved from
<https://linked.art/ns/v1/linked-art.json> on 12 September 2026. Its SHA-256 is
`3017421203aba8ea73f159aced1285e35b37cee49b5648cf19b01f237025f165`.
The exporter also records the hash of its RFC 8785 serialization, which is the
representation included in the dossier. Verification needs no remote context fetch.

The candidate profile targets Linked Art Model 1.0.0, CIDOC CRM 7.1.3 and the
CRMdig digital-object extension. It does not claim Linked Art HTTP API
conformance, an onchain schema registration, or complete Stream conformance.

The mapper validates its emitted class/property subset and preserves the entire
source snapshot. Every artist field has a coverage row. A projected field can
still contain source-only information; `projected_with_source_retained` is not
a lossless round-trip claim for Linked Art alone. Runtime, dependency, byte
derivation, rights, authority proposals and precise participant roles remain in
the source sidecar where the mapper has no faithful supported projection.
Nonlinguistic sound, software and composite content are E73 information objects
in the separate CRM extension graph; they are never forced into a textual-work
carrier relationship. Authenticated institutional recorders whose person/group
kind is not established use E39 Actor in the extension graph. Their statements
and authority assignments remain attributed independently from the artist.

The exporter creates distinct local identities for content, received bytes and
physical objects. Declared physical receipt does not create a title or custody
transfer. An artist-supplied authority link does not become a reviewed equivalent.
Unknown and approximate dates remain distinguishable from exact bounded dates.

Reviewed identity matches require a compatible entity kind, canonical authority
IRI, an archived snapshot with byte fixity, recorder and recording time. The
Linked Art Place convention uses the canonical TGN record in `la:equivalent`;
the separately evidenced `-place` focus is preserved in the source assertion.
The mapper does not emit `owl:sameAs`, equate that concept with its focus, or
promote weaker matches. Disputed, withdrawn, superseded and unreviewed matches
remain source statements. Multiple reviewed targets within one authority are
retained as conflicting assignments; no timestamp winner is selected.

PREMIS 3.0 describes the intellectual work, components, documents and files,
original fixity, measured format, separate scan/C2PA outcomes, recorded agents,
completed preservation events and scoped rights assertions. Journal recording
events are distinct from the described activities; planned activities are not
reported as performed. A stored digest calculation does not become a historical
fixity comparison. Unknown operation times remain unknown. Program requirements,
intended terms and prose permissions are not converted into executed grants;
explicit artist material permissions remain attributed assertions. Physical
objects and richer rights/source details remain in the accompanying source.

Relevant official model references:

- [Digital objects and carriers](https://linked.art/model/digital/)
- [Events and activities](https://linked.art/model/event/)
- [Dimensions](https://linked.art/api/1.0/shared/dimension/)
- [Linked Art model baseline](https://linked.art/model/)
- [Attribute assignment and attribution](https://linked.art/model/assertion/)
- [Place identity conventions](https://linked.art/api/1.0/endpoint/place/)
- [PREMIS 3.0 XML schema](https://www.loc.gov/standards/premis/v3/premis-v3-0.xsd)

Behavioral and negative vectors are in `../linked-art.test.ts`. The exact
mapping rules and emitted per-property source selectors accompany each export.
