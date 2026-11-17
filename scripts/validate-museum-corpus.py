"""Check generated museum corpus fixity and locked LIDO/PREMIS XSDs offline.

Usage: python scripts/validate-museum-corpus.py /path/to/corpus
Requires lxml and jsonschema. Does not execute artwork, access the database or use the network.
Fixture-only golden check: thirteen capture cases, each with LIDO, PREMIS and IIIF,
plus four bound publication manifests compiled by the museum publication adapter.
Use validate-artwork-dossier.py for a portable artwork dossier, not this corpus checker.
"""
from pathlib import Path
import hashlib
import json
import sys
from lxml import etree
from jsonschema import Draft7Validator
from museum_iiif_validation import verify_selector_types


def check(condition, message):
    if not condition:
        raise ValueError(message)


class LockedResolver(etree.Resolver):
    def __init__(self, directory, lock):
        self.directory = directory
        self.lock = lock

    def resolve(self, url, public_id, context):
        item = self.lock.get(url)
        if not item:
            raise ValueError('Unpinned XML schema: '+url)
        path = self.directory/item['file']
        data = path.read_bytes()
        check(hashlib.sha256(data).hexdigest() == item['sha256'], 'Pinned schema digest mismatch')
        return self.resolve_string(data, context, base_url=url)


# The IIIF Presentation 3 schema mandates the http form of these vocabulary URIs.
# They are compared as identifiers only; nothing is fetched.
RIGHTS_PREFIXES = (  # NOSONAR: normative IIIF rights vocabulary identifiers, never requested over the network.
    'http://creativecommons.org/licenses/',  # NOSONAR
    'http://creativecommons.org/publicdomain/',  # NOSONAR
    'http://rightsstatements.org/vocab/',  # NOSONAR
)


def corpus_file(directory, item):
    path_name = item['path']
    check(isinstance(path_name, str) and path_name not in ('.', '..') and '/' not in path_name and '\\' not in path_name and Path(path_name).name == path_name, 'Invalid corpus filename')
    path = directory/path_name
    check(not path.is_symlink() and path.resolve().parent == directory.resolve(), 'Invalid corpus filename')
    data = path.read_bytes()
    check(hashlib.sha256(data).hexdigest() == item['sha256'], 'Corpus file digest mismatch')
    return data


def validate_publication(data, iiif_validator):
    manifest = json.loads(data)
    verify_selector_types(manifest)
    iiif_validator.validate(manifest)
    check(next(iter(manifest)) == '@context', 'Publication manifest must start with @context')
    check(isinstance(manifest.get('rights'), str) and manifest['rights'].startswith(RIGHTS_PREFIXES), 'Publication rights must be a Creative Commons or RightsStatements.org http URI')
    check(isinstance(manifest.get('requiredStatement'), dict), 'Publication manifest needs a required statement')
    check(isinstance(manifest.get('items'), list) and len(manifest['items']) > 0, 'Publication manifest needs at least one canvas')
    check('example.invalid' not in data.decode('utf-8'), 'Publication manifest still carries the unserved draft base')


def validate(directory):
    schemas = Path(__file__).resolve().parent.parent/'src/artwork-documentation/museum/export/schemas'
    lock = json.loads((schemas/'schema-lock.json').read_bytes())
    parser = etree.XMLParser(resolve_entities=False, no_network=True)
    parser.resolvers.add(LockedResolver(schemas, lock))
    urls = {'lido': 'https://www.lido-schema.org/schema/v1.1/lido-v1.1.xsd',
            'premis': 'https://www.loc.gov/standards/premis/v3/premis-v3-0.xsd'}
    validators = {}
    for kind, url in urls.items():
        item = lock[url]
        data = (schemas/item['file']).read_bytes()
        check(hashlib.sha256(data).hexdigest() == item['sha256'], 'Pinned schema digest mismatch')
        validators[kind] = etree.XMLSchema(etree.fromstring(data, parser, base_url=url))
    manifest = json.loads((directory/'corpus-manifest.json').read_bytes())
    iiif_item = next(item for item in lock.values() if item['file'] == 'iiif-presentation-3.json')
    iiif_bytes = (schemas/iiif_item['file']).read_bytes()
    check(hashlib.sha256(iiif_bytes).hexdigest() == iiif_item['sha256'], 'Pinned IIIF schema digest mismatch')
    iiif_schema = json.loads(iiif_bytes)
    Draft7Validator.check_schema(iiif_schema)
    iiif_validator = Draft7Validator(iiif_schema)
    check(len(manifest['cases']) == 13, 'Expected thirteen corpus cases')
    count = 0
    iiif_count = 0
    for case in manifest['cases']:
        for item in case['files']:
            data = corpus_file(directory, item)
            if item['path'].endswith('-iiif.json'):
                iiif_manifest = json.loads(data)
                verify_selector_types(iiif_manifest)
                iiif_validator.validate(iiif_manifest)
                iiif_count += 1
            for kind, validator in validators.items():
                if item['path'].endswith('-'+kind+'.xml'):
                    validator.assertValid(etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True)))
                    count += 1
    check(count == 26, 'Expected twenty-six XML projections')
    check(iiif_count == 13, 'Expected thirteen IIIF manifests')
    publications = manifest.get('publications', [])
    check(len(publications) == 4, 'Expected four publication manifests')
    for item in publications:
        check(item['path'].startswith('publication-') and item['path'].endswith('.json'), 'Invalid publication filename')
        validate_publication(corpus_file(directory, item), iiif_validator)
    print('Validated 13 capture cases, 26 official XSD projections, 13 IIIF manifests, 4 bound publication manifests and all generated file digests.')


if __name__ == '__main__':
    validate(Path(sys.argv[1]).resolve())
