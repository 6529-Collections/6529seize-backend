"""Supplement the pinned upstream IIIF schema's known selector type gaps."""


def verify_selector_types(value):
    if isinstance(value, list):
        for child in value:
            verify_selector_types(child)
    elif isinstance(value, dict):
        selector_type = value.get('type')
        fields = ()
        if selector_type in ('FragmentSelector', 'SvgSelector'):
            fields = ('value',)
        elif selector_type == 'ImageApiSelector':
            fields = ('region', 'size', 'rotation', 'quality', 'format')
        for field in fields:
            if field in value and not isinstance(value[field], str):
                raise ValueError(f'{selector_type}.{field} must be a string')
        for child in value.values():
            verify_selector_types(child)
