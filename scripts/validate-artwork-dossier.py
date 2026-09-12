"""Independently verify an exported OCFL/BagIt dossier and its pinned XML schemas.

Usage: python scripts/validate-artwork-dossier.py /path/to/extracted/object
Requires lxml. No network requests, asset execution, or database access occurs.
"""
from pathlib import Path
import hashlib
import json
import re
import sys
from lxml import etree
from jsonschema import Draft7Validator
from museum_iiif_validation import verify_selector_types


def check(condition, message):
    if not condition:
        raise ValueError(message)


def safe(root, path):
    check(isinstance(path, str) and re.fullmatch(r'[a-zA-Z0-9_.=/-]+', path), 'Unsafe object path')
    parts = path.split('/')
    check(all(part and part not in ('.', '..') for part in parts), 'Unsafe object path')
    base = root.resolve()
    result = base
    for part in parts:
        result = result / part
        check(not result.is_symlink(), 'Symbolic links are not supported in dossiers')
    check(result.resolve().is_relative_to(base), 'Unsafe object path')
    return result


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def verify_object(root):
    check(safe(root, '0=ocfl_object_1.1').read_bytes() == b'ocfl_object_1.1\n', 'Invalid OCFL declaration')
    inventory_path = safe(root, 'inventory.json')
    inventory = json.loads(inventory_path.read_bytes())
    check(inventory['type'] == 'https://ocfl.io/1.1/spec/#inventory', 'Unsupported OCFL inventory')
    check(inventory['digestAlgorithm'] == 'sha256', 'Unsupported OCFL digest')
    head = inventory['head']
    check(isinstance(head, str) and re.fullmatch(r'v[1-9][0-9]*', head), 'Invalid OCFL head')
    sidecar = safe(root, 'inventory.json.sha256').read_text(encoding='utf-8')
    check(sidecar == digest(inventory_path)+' inventory.json\n', 'OCFL inventory digest mismatch')
    check(safe(root, head+'/inventory.json').read_bytes() == inventory_path.read_bytes(), 'OCFL head inventory mismatch')
    check(safe(root, head+'/inventory.json.sha256').read_text(encoding='utf-8') == sidecar, 'OCFL head digest mismatch')
    manifest_paths = set()
    for expected, paths in inventory['manifest'].items():
        for path in paths:
            check(isinstance(path, str) and re.match(r'^v[1-9][0-9]*/content/', path), 'Invalid OCFL content path')
            check(digest(safe(root,path)) == expected, 'OCFL content digest mismatch')
            check(path not in manifest_paths, 'Duplicate OCFL content path')
            manifest_paths.add(path)
    actual_content = {str(path.relative_to(root)).replace('\\','/') for path in root.glob('v*/content/**/*') if path.is_file()}
    check(actual_content == manifest_paths, 'OCFL content manifest does not match files')
    for expected in inventory['versions'][inventory['head']]['state']:
        check(expected in inventory['manifest'], 'OCFL state digest missing from manifest')
    return safe(root, head+'/content/bag')


def verify_bag(root):
    check(safe(root, 'bagit.txt').read_bytes() == b'BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n', 'Unsupported BagIt declaration')
    payload = set()
    for manifest in ('manifest-sha256.txt','tagmanifest-sha256.txt'):
        for line in safe(root, manifest).read_text(encoding='utf-8').splitlines():
            expected, path = line.split('  ',1)
            check(digest(safe(root,path)) == expected, 'BagIt digest mismatch')
            if manifest.startswith('manifest-'):
                check(path not in payload, 'Duplicate BagIt payload')
                payload.add(path)
    actual = {str(path.relative_to(root)).replace('\\','/') for path in (root/'data').rglob('*') if path.is_file()}
    check(payload == actual, 'BagIt payload manifest does not match files')


class LockedResolver(etree.Resolver):
    def __init__(self, directory, lock):
        self.directory = directory
        self.lock = lock

    def resolve(self, url, public_id, context):
        item = self.lock.get(url)
        if not item:
            raise ValueError('Unpinned schema requested: '+url)
        path = safe(self.directory, item['file'])
        check(digest(path) == item['sha256'], 'Pinned schema digest mismatch')
        return self.resolve_string(path.read_bytes(), context, base_url=url)


def verify_xml(root):
    directory=safe(root, 'data/metadata/schemas')
    lock=json.loads(safe(directory, 'schema-lock.json').read_bytes())
    parser=etree.XMLParser(resolve_entities=False,no_network=True)
    parser.resolvers.add(LockedResolver(directory,lock))
    for name, url in [('premis','https://www.loc.gov/standards/premis/v3/premis-v3-0.xsd'),('lido','https://www.lido-schema.org/schema/v1.1/lido-v1.1.xsd')]:
        schema=etree.XMLSchema(etree.parse(url,parser))
        document=etree.parse(str(safe(root, f'data/metadata/{name}.xml')),etree.XMLParser(resolve_entities=False,no_network=True))
        schema.assertValid(document)
        print(name,'XSD validation passed')


def verify_iiif(root):
    directory = safe(root, 'data/metadata/schemas')
    schema = json.loads(safe(directory, 'iiif-presentation-3.json').read_bytes())
    manifest = json.loads(safe(root, 'data/metadata/iiif-manifest.json').read_bytes())
    verify_selector_types(manifest)
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
