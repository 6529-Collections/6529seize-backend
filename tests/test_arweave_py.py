import os
import json
import pytest
import asyncio
from arweave_py import (
    DummyArweave,
    ArweaveFileUploader,
    get_arweave_instance,
    _arweave_and_key
)

@pytest.fixture(autouse=True)
def reset_singleton():
    yield
    # reset singleton between tests
    globals()['_arweave_and_key'] = None


def test_get_arweave_instance_caches_result(tmp_path, monkeypatch):
    monkeypatch.setenv('ARWEAVE_KEY', json.dumps({'k': 'v'}))
    first = get_arweave_instance()
    second = get_arweave_instance()
    assert first is second, 'instance should be cached'
    assert first['key'] == {'k': 'v'}


def test_get_arweave_instance_missing_key(monkeypatch):
    monkeypatch.delenv('ARWEAVE_KEY', raising=False)
    with pytest.raises(RuntimeError):
        get_arweave_instance()


class RecordingSupplier:
    def __init__(self):
        self.called = False

    def __call__(self):
        self.called = True
        return {'arweave': DummyArweave('abc123'), 'key': 'secret'}


@pytest.mark.asyncio
def test_upload_file_process(monkeypatch):
    supplier = RecordingSupplier()
    uploader = ArweaveFileUploader(supplier)
    result = asyncio.run(uploader.upload_file(b'data', 'text/plain'))
    assert result['url'] == 'https://arweave.net/abc123'
    # 3 chunks => 3 log messages
    assert len(uploader.infos) == 3
    assert supplier.called
