"""Logical state transfer. New pins survive; mutable writes remain fenced until sync.

The caller owns the root-only router journal. This module never changes routing,
deletes content blocks, copies a live LevelDB, or restores a peer's private key.
"""
import concurrent.futures
import hashlib
import json
import time

from common import require, write_private

FILE_STAT = "files/stat"
PIN_ADD = "pin/add"


def explicit_pins(call):
    pins = {}
    names = {}
    for kind in ("recursive", "direct"):
        entries = call("pin/ls", {"type": kind, "names": "true"}).get("Keys") or {}
        require(isinstance(entries, dict), "Invalid pin inventory")
        for cid, entry in entries.items():
            require(entry.get("Type") == kind, "Unexpected pin category")
            pins[cid] = kind
            names[cid] = entry.get("Name", "")
    return {"pins": pins, "pinNames": names}


def reference_state(call):
    return {**explicit_pins(call), "mfsRoot": call(FILE_STAT, {"arg": "/", "hash": "true"})["Hash"]}


def snapshot(call):
    call("files/flush", {"arg": "/"})
    for _ in range(8):
        first = reference_state(call)
        if first == reference_state(call):
            # Retain the immutable MFS root independently of the mutable handle.
            # The private snapshot is valid even if future uploads change MFS.
            if first["pins"].get(first["mfsRoot"]) != "recursive":
                call(PIN_ADD, {"arg": first["mfsRoot"], "recursive": "true"}, timeout=1800)
                first["pins"][first["mfsRoot"]] = "recursive"
                first["pinNames"].setdefault(first["mfsRoot"], "")
            return first
        time.sleep(1)
    raise ValueError("State kept changing; no consistent snapshot recorded")


def validate_snapshot(saved):
    require(isinstance(saved, dict) and isinstance(saved.get("pins"), dict), "Missing pin inventory")
    require(isinstance(saved.get("pinNames"), dict) and isinstance(saved.get("mfsRoot"), str), "Missing file state")
    require(all(isinstance(cid, str) and kind in ("recursive", "direct") for cid, kind in saved["pins"].items()), "Invalid saved pins")
    require(set(saved["pinNames"]).issubset(saved["pins"]), "Pin names refer to unknown content")


def merge_pins(saved, call, workers=8):
    validate_snapshot(saved)
    current = explicit_pins(call)

    def retain(item):
        cid, kind = item
        existing = current["pins"].get(cid)
        if existing == "recursive" or existing == kind:
            return
        name = current["pinNames"].get(cid) or saved["pinNames"].get(cid, "")
        call(PIN_ADD, {"arg": cid, "recursive": str(kind == "recursive").lower(), "name": name}, timeout=1800)

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        # Consume all results: an RPC failure cannot be hidden in a future.
        list(pool.map(retain, saved["pins"].items()))
    actual = explicit_pins(call)["pins"]
    require(all(actual.get(cid) == kind or actual.get(cid) == "recursive" for cid, kind in saved["pins"].items()), "Source pins were not retained")
    require(set(current["pins"]).issubset(actual), "Destination pins were lost")
    return len(saved["pins"])


def state_hash(saved):
    return hashlib.sha256(json.dumps(saved, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def replace_fenced_mfs(saved, call, router, journal_path, migration_id, baseline_root):
    """Only replace a proven baseline while all public MFS writes are waiting.

    Normal immutable uploads may already have completed on this node: their pins
    are never removed. A durable journal permits retry after any subtree copy.
    """
    validate_snapshot(saved)
    status = router()
    require(status["mode"] == "serve" and not status["mfsReady"], "Mutable writes must remain fenced during state transfer")
    expected = {"migrationId": migration_id, "sourceRoot": saved["mfsRoot"],
                "baselineRoot": baseline_root, "routerEpoch": status["epoch"]}
    if journal_path.exists():
        journal = json.loads(journal_path.read_text())
        require(all(journal.get(key) == value for key, value in expected.items()), "Different state transfer already owns this node")
    else:
        current = call(FILE_STAT, {"arg": "/", "hash": "true"})["Hash"]
        require(current == baseline_root, "Destination mutable state changed before its fence")
        write_private(journal_path, {**expected, "status": "copying"})
    # No public MFS operation can reach Kubo while this fence is held. On retry
    # it is safe to rebuild a partial tree; every previous root remains pinned.
    current = call(FILE_STAT, {"arg": "/", "hash": "true"})["Hash"]
    if current != saved["mfsRoot"]:
        call(PIN_ADD, {"arg": current, "recursive": "true"}, timeout=1800)
        for entry in call("files/ls", {"arg": "/"}).get("Entries") or []:
            call("files/rm", {"arg": "/" + entry["Name"], "recursive": "true"})
        listing = call("ls", {"arg": "/ipfs/" + saved["mfsRoot"]})["Objects"]
        require(len(listing) == 1, "Invalid immutable MFS root")
        for entry in listing[0].get("Links") or []:
            name = entry["Name"]
            require(name and "/" not in name and name not in (".", ".."), "Invalid MFS child")
            call("files/cp", {"arg": ["/ipfs/" + saved["mfsRoot"] + "/" + name, "/" + name]})
    call("files/flush", {"arg": "/"})
    require(call(FILE_STAT, {"arg": "/", "hash": "true"})["Hash"] == saved["mfsRoot"], "MFS transfer differs from the final source root")
    require(router()["epoch"] == status["epoch"] and not router()["mfsReady"], "Mutable-write fence changed during transfer")
    write_private(journal_path, {**expected, "status": "complete"})
    return {"mfsVerified": True, "sourceRoot": saved["mfsRoot"]}
