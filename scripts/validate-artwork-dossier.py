"""Independently verify an exported OCFL/BagIt dossier and its pinned XML schemas.

Usage: python scripts/validate-artwork-dossier.py /path/to/extracted/object
Requires lxml. No network requests, asset execution, or database access occurs.
"""
from pathlib import Path
import hashlib
import json
import sys
from lxml import etree
from jsonschema import Draft7Validator


def safe(root, path):
    result = (root / path).resolve()
    if not result.is_relative_to(root.resolve()) or result.is_symlink():
        raise ValueError('Unsafe object path')
    return result


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def verify_object(root):
    assert (root/'0=ocfl_object_1.1').read_bytes() == b'ocfl_object_1.1\n'
    inventory = json.loads((root/'inventory.json').read_bytes())
    assert inventory['type'] == 'https://ocfl.io/1.1/spec/#inventory'
    assert inventory['digestAlgorithm'] == 'sha256'
    sidecar = (root/'inventory.json.sha256').read_text(encoding='utf-8')
    assert sidecar == digest(root/'inventory.json')+' inventory.json\n'
    assert (root/inventory['head']/'inventory.json').read_bytes() == (root/'inventory.json').read_bytes()
    manifest_paths = set()
    for expected, paths in inventory['manifest'].items():
        for path in paths:
            assert digest(safe(root,path)) == expected, path
            assert path not in manifest_paths
            manifest_paths.add(path)
    actual_content = {str(path.relative_to(root)).replace('\\','/') for path in root.glob('v*/content/**/*') if path.is_file()}
    assert actual_content == manifest_paths
    for expected in inventory['versions'][inventory['head']]['state']:
        assert expected in inventory['manifest']
    return root/inventory['head']/'content'/'bag'


def verify_bag(root):
    assert (root/'bagit.txt').read_bytes() == b'BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n'
    payload = set()
    for manifest in ('manifest-sha256.txt','tagmanifest-sha256.txt'):
        for line in (root/manifest).read_text(encoding='utf-8').splitlines():
            expected, path = line.split('  ',1)
            assert digest(safe(root,path)) == expected, path
            if manifest.startswith('manifest-'):
                assert path not in payload
                payload.add(path)
    actual = {str(path.relative_to(root)).replace('\\','/') for path in (root/'data').rglob('*') if path.is_file()}
    assert payload == actual


class LockedResolver(etree.Resolver):
    def __init__(self, directory, lock):
        self.directory = directory
        self.lock = lock

    def resolve(self, url, public_id, context):
        item = self.lock.get(url)
        if not item:
            raise ValueError('Unpinned schema requested: '+url)
        path = self.directory/item['file']
        assert digest(path) == item['sha256']
        return self.resolve_string(path.read_bytes(), context, base_url=url)


def verify_xml(root):
    directory=root/'data'/'metadata'/'schemas'
    lock=json.loads((directory/'schema-lock.json').read_bytes())
    parser=etree.XMLParser(resolve_entities=False,no_network=True)
    parser.resolvers.add(LockedResolver(directory,lock))
    for name, url in [('premis','https://www.loc.gov/standards/premis/v3/premis-v3-0.xsd'),('lido','https://www.lido-schema.org/schema/v1.1/lido-v1.1.xsd')]:
        schema=etree.XMLSchema(etree.parse(url,parser))
        document=etree.parse(str(root/'data'/'metadata'/f'{name}.xml'),etree.XMLParser(resolve_entities=False,no_network=True))
        schema.assertValid(document)
        print(name,'XSD validation passed')


def verify_iiif(root):
    directory = root/'data'/'metadata'/'schemas'
    schema = json.loads((directory/'iiif-presentation-3.json').read_bytes())
    manifest = json.loads((root/'data'/'metadata'/'iiif-manifest.json').read_bytes())
    Draft7Validator.check_schema(schema)
    validator = Draft7Validator(schema)
    errors = list(validator.iter_errors(manifest))
    if errors:
        def report(error, depth=0):
            print('  '*depth, '/'.join(map(str,error.path)), error.message[:300])
            for child in error.context:
                report(child,depth+1)
        for error in errors:
            report(error)
        raise ValueError('IIIF Presentation 3 schema validation failed')
    print('IIIF Presentation 3 official pinned schema validation passed')


if __name__ == '__main__':
    root=Path(sys.argv[1]).resolve()
    bag=verify_object(root)
    verify_bag(bag)
    verify_xml(bag)
    verify_iiif(bag)
    print('OCFL inventory, BagIt payload/tag fixity, PREMIS, LIDO and IIIF validated without database or network')
