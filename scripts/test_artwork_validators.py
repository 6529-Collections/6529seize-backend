"""Exercise archive integrity and hostile paths, including under python -O."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dossier = load('dossier_validator', 'validate-artwork-dossier.py')
corpus = load('corpus_validator', 'validate-museum-corpus.py')


class ArchiveValidationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def inventory(self, **overrides):
        data = b'Original artist text'
        self.write('0=ocfl_object_1.1', b'ocfl_object_1.1\n')
        self.write('v1/content/bag/data/record.txt', data)
        digest = hashlib.sha256(data).hexdigest()
        inventory = {
            'type': 'https://ocfl.io/1.1/spec/#inventory',
            'digestAlgorithm': 'sha256',
            'head': 'v1',
            'manifest': {digest: ['v1/content/bag/data/record.txt']},
            'versions': {'v1': {'state': {digest: ['bag/data/record.txt']}}},
            **overrides,
        }
        encoded = json.dumps(inventory).encode('utf-8')
        sidecar = (hashlib.sha256(encoded).hexdigest() + ' inventory.json\n').encode('utf-8')
        for prefix in ('', 'v1/'):
            self.write(prefix + 'inventory.json', encoded)
            self.write(prefix + 'inventory.json.sha256', sidecar)

    def test_accepts_intact_object_and_rejects_changed_original(self):
        self.inventory()
        self.assertEqual(dossier.verify_object(self.root), self.root / 'v1/content/bag')
        self.write('v1/content/bag/data/record.txt', b'Changed artist text')
        with self.assertRaisesRegex(ValueError, 'content digest mismatch'):
            dossier.verify_object(self.root)

    def test_rejects_changed_marker_and_head_sidecar(self):
        self.inventory()
        self.write('0=ocfl_object_1.1', b'not OCFL')
        with self.assertRaisesRegex(ValueError, 'Invalid OCFL declaration'):
            dossier.verify_object(self.root)
        self.inventory()
        self.write('v1/inventory.json.sha256', b'incorrect')
        with self.assertRaisesRegex(ValueError, 'head digest mismatch'):
            dossier.verify_object(self.root)

    def test_rejects_unlisted_original(self):
        self.inventory()
        self.write('v1/content/bag/data/extra.txt', b'unlisted')
        with self.assertRaisesRegex(ValueError, 'manifest does not match files'):
            dossier.verify_object(self.root)

    def test_rejects_untrusted_head_before_following_it(self):
        for head in ('../outside', '/tmp/outside', 'v0', 'v1/../../outside', None):
            with self.subTest(head=head):
                self.inventory(head=head)
                with self.assertRaisesRegex(ValueError, 'Invalid OCFL head'):
                    dossier.verify_object(self.root)

    def test_rejects_path_escape_and_platform_specific_paths(self):
        for path in ('../outside', 'v1/../../outside', '/outside', 'C:/outside',
                     'v1\\outside', 'v1//outside', 'v1/./outside', 'v1/file:stream', ''):
            with self.subTest(path=path):
                with self.assertRaisesRegex(ValueError, 'Unsafe object path'):
                    dossier.safe(self.root, path)

    def test_schema_lock_cannot_read_outside_its_directory(self):
        resolver = dossier.LockedResolver(self.root, {
            'https://example.invalid/schema.xsd': {'file': '../outside.xsd', 'sha256': '0' * 64}
        })
        with self.assertRaisesRegex(ValueError, 'Unsafe object path'):
            resolver.resolve('https://example.invalid/schema.xsd', None, None)

    def test_rejects_symlinked_original(self):
        target = self.write('original.txt', b'original')
        link = self.root / 'linked.txt'
        try:
            link.symlink_to(target)
        except OSError as error:
            self.skipTest('Host does not allow symbolic links: ' + str(error))
        with self.assertRaisesRegex(ValueError, 'Symbolic links'):
            dossier.safe(self.root, 'linked.txt')

    def test_bag_integrity_is_not_an_optional_assertion(self):
        data = b'original'
        self.write('bagit.txt', b'BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n')
        self.write('data/original.txt', data)
        self.write('manifest-sha256.txt', (hashlib.sha256(data).hexdigest() + '  data/original.txt\n').encode('utf-8'))
        self.write('tagmanifest-sha256.txt', b'')
        dossier.verify_bag(self.root)
        self.write('data/original.txt', b'changed')
        with self.assertRaisesRegex(ValueError, 'BagIt digest mismatch'):
            dossier.verify_bag(self.root)

    def test_corpus_case_count_and_fixity_are_required(self):
        self.write('corpus-manifest.json', b'{"cases": []}')
        with self.assertRaisesRegex(ValueError, 'thirteen corpus cases'):
            corpus.validate(self.root)
        manifest = {'cases': [{'files': [{'path': 'original.txt', 'sha256': '0' * 64}]}] * 13}
        self.write('corpus-manifest.json', json.dumps(manifest).encode('utf-8'))
        self.write('original.txt', b'changed')
        with self.assertRaisesRegex(ValueError, 'Corpus file digest mismatch'):
            corpus.validate(self.root)
        manifest['cases'][0]['files'][0]['path'] = '../outside'
        self.write('corpus-manifest.json', json.dumps(manifest).encode('utf-8'))
        with self.assertRaisesRegex(ValueError, 'Invalid corpus filename'):
            corpus.validate(self.root)


if __name__ == '__main__':
    unittest.main()
