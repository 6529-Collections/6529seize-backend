import json
import os
from dataclasses import dataclass

_arweave_and_key = None

@dataclass
class DummyArweaveTransaction:
    id: str
    tags: dict

    def add_tag(self, key: str, value: str) -> None:
        self.tags[key] = value


class DummyUploader:
    def __init__(self, total_chunks: int = 3):
        self.total_chunks = total_chunks
        self.uploaded_chunks = 0

    @property
    def is_complete(self) -> bool:
        return self.uploaded_chunks >= self.total_chunks

    @property
    def pct_complete(self) -> int:
        if self.total_chunks == 0:
            return 100
        return int(self.uploaded_chunks / self.total_chunks * 100)

    async def upload_chunk(self) -> None:
        if not self.is_complete:
            self.uploaded_chunks += 1


class DummyArweave:
    def __init__(self, tx_id: str = 'txid'):
        self.tx_id = tx_id
        self.transactions = self

    async def create_transaction(self, payload: dict, key: any) -> DummyArweaveTransaction:
        return DummyArweaveTransaction(id=self.tx_id, tags={})

    async def sign(self, tx: DummyArweaveTransaction, key: any) -> None:
        pass

    async def get_uploader(self, tx: DummyArweaveTransaction) -> DummyUploader:
        return DummyUploader()


class ArweaveFileUploader:
    def __init__(self, supplier):
        self.supplier = supplier
        self.logger = self
        self.infos = []

    def info(self, msg: str) -> None:
        self.infos.append(msg)

    async def upload_file(self, file_buffer: bytes, content_type: str) -> dict:
        arweave_obj = self.supplier()
        arweave = arweave_obj['arweave']
        key = arweave_obj['key']
        tx = await arweave.create_transaction({'data': file_buffer}, key)
        tx.add_tag('Content-Type', content_type)
        await arweave.sign(tx, key)
        uploader = await arweave.get_uploader(tx)
        while not uploader.is_complete:
            await uploader.upload_chunk()
            self.info(
                f"Arweave upload {tx.id} {uploader.pct_complete}% complete, {uploader.uploaded_chunks}/{uploader.total_chunks}"
            )
        return {'url': f'https://arweave.net/{tx.id}'}


def get_arweave_instance():
    global _arweave_and_key
    if _arweave_and_key is None:
        if 'ARWEAVE_KEY' not in os.environ:
            raise RuntimeError('ARWEAVE_KEY not set')
        key = json.loads(os.environ['ARWEAVE_KEY'])
        arweave = DummyArweave()
        _arweave_and_key = {'arweave': arweave, 'key': key}
    return _arweave_and_key
