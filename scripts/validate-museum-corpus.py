"""Check generated museum corpus fixity and locked LIDO/PREMIS XSDs offline.

Usage: python scripts/validate-museum-corpus.py /path/to/corpus
Requires lxml and jsonschema. Does not execute artwork, access the database or use the network.
"""
from pathlib import Path
import hashlib
import json
import sys
from lxml import etree
from jsonschema import Draft7Validator


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
        assert hashlib.sha256(data).hexdigest() == item['sha256'], url
        return self.resolve_string(data, context, base_url=url)


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
        assert hashlib.sha256(data).hexdigest() == item['sha256'], url
        validators[kind] = etree.XMLSchema(etree.fromstring(data, parser, base_url=url))
    manifest = json.loads((directory/'corpus-manifest.json').read_bytes())
    iiif_item = next(item for item in lock.values() if item['file'] == 'iiif-presentation-3.json')
    iiif_bytes = (schemas/iiif_item['file']).read_bytes()
    assert hashlib.sha256(iiif_bytes).hexdigest() == iiif_item['sha256']
    iiif_schema = json.loads(iiif_bytes)
    Draft7Validator.check_schema(iiif_schema)
    iiif_validator = Draft7Validator(iiif_schema)
    assert len(manifest['cases']) == 13
    count = 0
    iiif_count = 0
    for case in manifest['cases']:
        for item in case['files']:
            assert Path(item['path']).name == item['path']
            data = (directory/item['path']).read_bytes()
            assert hashlib.sha256(data).hexdigest() == item['sha256'], item['path']
            if item['path'].endswith('-iiif.json'):
                iiif_validator.validate(json.loads(data))
                iiif_count += 1
            for kind, validator in validators.items():
                if item['path'].endswith('-'+kind+'.xml'):
                    validator.assertValid(etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True)))
                    count += 1
    assert count == 26
    assert iiif_count == 13
    print('Validated 13 capture cases, 26 official XSD projections, 13 IIIF manifests and all generated file digests.')


if __name__ == '__main__':
    validate(Path(sys.argv[1]).resolve())
