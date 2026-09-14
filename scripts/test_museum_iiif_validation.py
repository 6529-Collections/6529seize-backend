"""Regression checks for known gaps in the unchanged upstream selector schema."""
import json
from pathlib import Path
import unittest
from jsonschema import Draft7Validator
from museum_iiif_validation import verify_selector_types


class SelectorValidationTest(unittest.TestCase):
    def test_rejects_values_the_pinned_upstream_schema_accepts(self):
        path = Path(__file__).resolve().parent.parent / 'src/artwork-documentation/museum/export/schemas/iiif-presentation-3.json'
        schema = json.loads(path.read_bytes())
        selector_schema = dict(schema, **{'$ref': '#/classes/selector'})
        validator = Draft7Validator(selector_schema)
        for invalid in (
            {'type': 'FragmentSelector', 'value': 12},
            {'type': 'SvgSelector', 'value': False},
            {'type': 'ImageApiSelector', 'region': [0, 0, 100, 100]},
        ):
            with self.subTest(selector=invalid['type']):
                validator.validate(invalid)
                with self.assertRaises(ValueError):
                    verify_selector_types({'items': [{'selector': invalid}]})

    def test_preserves_valid_selectors_and_unrelated_metadata(self):
        verify_selector_types({'items': [
            {'selector': {'type': 'FragmentSelector', 'value': 'xywh=0,0,100,100'}},
            {'selector': {'type': 'SvgSelector', 'value': '<svg />'}},
            {'selector': {'type': 'ImageApiSelector', 'region': 'full', 'rotation': '0'}},
            {'selector': {'type': 'PointSelector', 'x': 10, 'y': 20}},
            {'type': 'TextualBody', 'value': 'Artist writing'},
        ]})


if __name__ == '__main__':
    unittest.main()
