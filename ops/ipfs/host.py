"""Managed candidate runtime. No deployment or restore targets an active server.

Logical backups contain private identity and live pin/MFS references, never a
possibly inconsistent copy of an open LevelDB. S3 content is protected separately.
"""
import argparse
import datetime
import json
import os
import pwd
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from common import ROOT, RECEIPT_PROTOCOL, aws, digest, extract, require, validate_config, write_private

FILE_STAT = 'files/stat'
VERSIONS_FILENAME = 'versions.json'
STATE_FILENAME = 'state.json'

RESTORE_SESSION_FILENAME = 'restore-session.json'
PIN_LIST = 'pin/ls'
MFS_LIST = 'files/ls'

REPO = Path("/var/lib/6529-ipfs")
SETTINGS = Path("/etc/6529-ipfs")
API = "http://127.0.0.1:5001/api/v0/"


def run(*args, timeout=180, user=False):
    command = ["runuser", "-u", "ipfs", "--", "env", "IPFS_PATH=" + str(REPO), *args] if user else list(args)
    result = subprocess.run(command, capture_output=True, timeout=timeout)
    require(result.returncode == 0, "Command failed: " + args[0] + "; output withheld to protect private configuration")
    return result.stdout


def rpc(operation, query=None, raw=False, timeout=120):
    url = API + operation + ("?" + urllib.parse.urlencode(query, doseq=True) if query else "")
    request = urllib.request.Request(url, data=b"", method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read()
    if raw:
        return data
    return json.loads(data) if data else {}


def pin_inventory():
    keys = rpc(PIN_LIST, {"type": "all"})["Keys"]
    return {cid: entry["Type"] for cid, entry in keys.items() if entry["Type"] in ("recursive", "direct")}


def references():
    entries = rpc(PIN_LIST, {"type": "all"})["Keys"]
    pins = {cid: entry["Type"] for cid, entry in entries.items() if entry["Type"] in ("recursive", "direct")}
    return {"pins": pins, "pinNames": {cid: entries[cid].get("Name", "") for cid in pins},
            "mfsRoot": rpc(FILE_STAT, {"arg": "/", "hash": "true"})["Hash"]}


def stable_references():
    for _ in range(5):
        before = references()
        if before == references():
            return before
    raise RuntimeError("Pin/MFS state kept changing; retry backup instead of recording inconsistent references")


def candidate_guard(config, allow_active=False):
    marker = json.loads((SETTINGS / "managed.json").read_text())
    require(marker.get("environment") == config["environment"] and marker.get("role") in
            (("candidate", "active") if allow_active else ("candidate",)), "Unmanaged or active host")


def stopped():
    result = subprocess.run(["systemctl", "is-active", "ipfs"], capture_output=True)
    require(result.returncode != 0, "Active daemon updates require a validated traffic handover; use a fresh candidate")


def ownership():
    user = pwd.getpwnam("ipfs")
    for path in [REPO, *REPO.rglob("*")]:
        os.chown(path, user.pw_uid, user.pw_gid)


def datastore(config, endpoint=None):
    store = {"type": "s3ds", "region": config["region"], "bucket": config["blocksBucket"],
             "rootDirectory": "ipfs", "accessKey": "", "secretKey": ""}
    if endpoint:
        store.update(regionEndpoint=endpoint, accessKey="fixture", secretKey="fixture")
    return {"type": "mount", "mounts": [
        {"mountpoint": "/blocks", "type": "measure", "prefix": "s3.datastore", "child": store},
        {"mountpoint": "/", "type": "measure", "prefix": "leveldb.datastore",
         "child": {"type": "levelds", "path": "datastore", "compression": "none"}},
    ]}


def configure_repo(config, repo=REPO, endpoint=None):
    path = repo / "config"
    data = json.loads(path.read_text())
    data["Datastore"]["Spec"] = datastore(config, endpoint)
    data["Addresses"]["API"] = "/ip4/127.0.0.1/tcp/5001"
    data["Addresses"]["Gateway"] = "/ip4/127.0.0.1/tcp/8080"
    data["Routing"]["Type"] = "dhtclient"
    data["API"]["HTTPHeaders"] = {
        "Access-Control-Allow-Origin": ["https://6529.io"] if config["environment"] == "prod" else ["https://staging.6529.io"],
        "Access-Control-Allow-Methods": ["POST", "OPTIONS"],
    }
    path.write_text(json.dumps(data, indent=2))
    path.chmod(0o600)
    # DiskSpec is the storage identity returned by the pinned S3 plugin. Runtime
    # credentials, instrumentation wrappers and endpoint overrides are excluded.
    spec = {"type": "mount", "mounts": [
        {"mountpoint": "/blocks", "bucket": config["blocksBucket"], "region": config["region"], "rootDirectory": "ipfs"},
        {"mountpoint": "/", "path": "datastore", "type": "levelds"},
    ]}
    (repo / "datastore_spec").write_text(json.dumps(spec, sort_keys=True, separators=(",", ":")))


def nginx_config(config):
    return (ROOT / "templates" / "nginx.conf").read_text().replace("@ORIGIN_HOST@", config["originHost"]).replace("@API_HOST@", config["apiHost"])


def install(config):
    candidate_guard(config)
    stopped()
    require(not (REPO / "config").exists(), "Existing repository must be restored or replaced explicitly")
    require(digest(ROOT / "ipfs", ROOT) == json.loads((ROOT / "release.json").read_text())["ipfsSha256"], "Binary checksum mismatch")
    # The candidate's role cannot delete content blocks. Neither init nor daemon
    # runs garbage collection. Check the known folder-marker startup regression.
    listing = aws("s3api", "list-objects-v2", "--region", config["region"], "--bucket", config["blocksBucket"],
                  "--prefix", "ipfs/", "--max-keys", "1", "--no-paginate")
    require(not any(item["Key"] == "ipfs/" for item in listing.get("Contents", [])), "S3 folder marker must be investigated before startup")
    try:
        pwd.getpwnam("ipfs")
    except KeyError:
        subprocess.run(["useradd", "--system", "--home-dir", str(REPO), "--shell", "/usr/sbin/nologin", "ipfs"],
                       capture_output=True, check=True)
    REPO.mkdir(mode=0o700, parents=True, exist_ok=True)
    ownership()
    run(str(ROOT / "ipfs"), "init", "--profile=server", "--empty-repo", user=True)
    configure_repo(config)
    ownership()
    run("systemctl", "mask", "nginx")
    run("apt-get", "-o", "Acquire::Retries=3", "update")
    run("apt-get", "-o", "Acquire::Retries=3", "install", "-y", "--no-install-recommends", "libpcre2-8-0", "libssl3t64", "zlib1g", "certbot", "python3-certbot-dns-route53", timeout=900)
    run("dpkg", "-i", str(ROOT / "nginx.deb"))
    run("certbot", "certonly", "--non-interactive", "--agree-tos", "--dns-route53", "--email", config["acmeEmail"],
        "--cert-name", "6529-ipfs", "-d", config["originHost"], "-d", config["apiHost"], timeout=600)
    Path("/etc/nginx/nginx.conf").write_text(nginx_config(config))
    Path("/etc/systemd/system/ipfs.service").write_text((ROOT / "templates" / "ipfs.service").read_text())
    renewal = Path("/etc/letsencrypt/renewal-hooks/deploy/6529-ipfs-nginx")
    renewal.parent.mkdir(parents=True, exist_ok=True)
    renewal.write_text("#!/bin/sh\nset -eu\nnginx -t\nsystemctl reload nginx\n")
    renewal.chmod(0o700)
    run("nginx", "-t")
    run("systemctl", "daemon-reload")
    run("systemctl", "unmask", "nginx")
    run("systemctl", "enable", "ipfs", "nginx", "certbot.timer")
    run("systemctl", "start", "ipfs")
    wait_ready()
    # init generated identity/config with a temporary local block layout.
    # Materialize the empty MFS/bootstrap root in the selected S3 datastore.
    rpc("files/flush", {"arg": "/"})
    run("systemctl", "start", "nginx", "certbot.timer")
    return verify(config)


def wait_ready():
    for _ in range(90):
        try:
            rpc("version", timeout=2)
            return
        except (OSError, ValueError):
            time.sleep(1)
    raise TimeoutError("IPFS failed to start")


def verify(config):
    journal = SETTINGS / RESTORE_SESSION_FILENAME
    require(not journal.exists() or json.loads(journal.read_text()).get("status") == "complete", "Candidate restore is incomplete")
    manifest = json.loads((ROOT / "release.json").read_text())
    require(digest(ROOT / "ipfs", ROOT) == manifest["ipfsSha256"], "Installed binary checksum mismatch")
    version = rpc("version")["Version"]
    require(version == json.loads((ROOT / VERSIONS_FILENAME).read_text())["kuboVersion"], "Runtime version mismatch")
    actual = json.loads((REPO / "config").read_text())["Datastore"]["Spec"]
    require(actual == datastore(config), "Datastore configuration drift")
    require(not (REPO / "plugins").exists() or not list((REPO / "plugins").glob("*.so")), "External plugin may conflict with bundled S3")
    # Real add/pin/read tests use the private loopback RPC; public routes are also
    # checked below without assuming that DNS has already been cut over.
    import secrets
    payload = ("6529 IPFS candidate " + secrets.token_hex(16)).encode()
    boundary = "6529-ipfs-verify"
    body = ("--" + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="health.txt"\r\n\r\n').encode() + payload + ("\r\n--" + boundary + "--\r\n").encode()
    request = urllib.request.Request(API + "add?pin=true", data=body, headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    with urllib.request.urlopen(request, timeout=120) as response:
        cid = json.loads(response.read())["Hash"]
    try:
        require(cid in pin_inventory(), "Probe was not pinned")
        require(rpc("cat", {"arg": cid}, raw=True) == payload, "Uploaded content changed")
        with urllib.request.urlopen("http://127.0.0.1:8080/ipfs/" + cid, timeout=120) as response:
            require(response.read() == payload, "Gateway probe mismatch")
    finally:
        rpc("pin/rm", {"arg": cid})
    # Probe bytes remain unpinned in isolated versioned storage. No content delete
    # privilege or production GC is introduced for the sake of a health check.
    run("nginx", "-t")
    def https(name, path, *arguments):
        return run("curl", "--silent", "--show-error", "--noproxy", "*", "--resolve", name + ":443:127.0.0.1",
                   *arguments, "https://" + name + path)
    require(json.loads(https(config["apiHost"], "/health"))["Version"] == version, "HTTPS API health mismatch")
    require(https(config["apiHost"], "/api/v0/version", "-X", "POST", "-o", "/dev/null", "-w", "%{http_code}") == b"403",
            "HTTPS exposes a restricted RPC route")
    return {"version": version, "pinCount": len(pin_inventory()), "uploadPinRead": True}


def upload_backup(config, saved, key):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / STATE_FILENAME
        path.write_text(json.dumps(saved))
        path.chmod(0o600)
        archive = Path(directory) / "metadata.tar.gz"
        with tarfile.open(archive, "w:gz") as target:
            target.add(path, arcname=STATE_FILENAME)
        result = aws("s3api", "put-object", "--region", config["region"], "--bucket", config["backupsBucket"],
                     "--key", key, "--body", str(archive), "--server-side-encryption", "AES256",
                     "--metadata", json.dumps({"sha256": digest(archive, directory)}))
        require(result.get("VersionId") not in (None, "null"), "Backup bucket must be versioned")
    return result["VersionId"]


def backup(config):
    rpc("files/flush", {"arg": "/"})
    before = stable_references()
    source = json.loads((REPO / "config").read_text())
    saved = {"schema": 1, "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
             "kuboVersion": rpc("version")["Version"], "versions": json.loads((ROOT / VERSIONS_FILENAME).read_text()),
             "blocksBucket": config["blocksBucket"], "blockPrefix": "ipfs", "identity": source["Identity"], **before}
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    key = config["environment"] + "/" + stamp + "/metadata.tar.gz"
    attempt_path = SETTINGS / "backup-attempts" / (stamp + ".json")
    attempt = {"backupKey": key, "mfsRoot": before["mfsRoot"], "status": "pending"}
    # The durable attempt record also survives termination between pinning and
    # upload. Retention pins are never automatically removed on upload failure:
    # another writer may have independently pinned the same immutable root.
    write_private(attempt_path, attempt)
    if before["pins"].get(before["mfsRoot"]) != "recursive":
        query = {"arg": before["mfsRoot"], "recursive": "true"}
        if before["pinNames"].get(before["mfsRoot"]):
            query["name"] = before["pinNames"][before["mfsRoot"]]
        rpc("pin/add", query, timeout=3600)
    saved["pins"][before["mfsRoot"]] = "recursive"
    saved["pinNames"].setdefault(before["mfsRoot"], "")
    version = upload_backup(config, saved, key)
    write_private(attempt_path, {**attempt, "status": "complete", "versionId": version})
    return {"backupKey": key, "versionId": version, "pinCount": len(saved["pins"])}


def mfs_entries(saved, call):
    require(isinstance(saved.get("mfsRoot"), str) and saved["mfsRoot"], "Missing MFS root")
    listing = call("ls", {"arg": "/ipfs/" + saved["mfsRoot"]})
    require(isinstance(listing, dict), "Malformed MFS listing")
    objects = listing.get("Objects")
    require(isinstance(objects, list) and len(objects) == 1 and isinstance(objects[0], dict), "Malformed MFS root listing")
    require("Links" in objects[0], "Missing MFS root links")
    entries = objects[0].get("Links")
    require(entries is None or isinstance(entries, list), "Malformed MFS root links")
    indexed = {}
    for entry in entries or []:
        require(isinstance(entry, dict), "Malformed MFS entry")
        name = entry.get("Name")
        require(isinstance(name, str) and name and name not in (".", "..") and "/" not in name, "Invalid MFS entry")
        require(isinstance(entry.get("Hash"), str) and entry["Hash"], "Missing MFS entry hash")
        require(name not in indexed, "Duplicate MFS entry")
        indexed[name] = entry
    return indexed


def existing_mfs(entries, call):
    current = call(MFS_LIST, {"arg": "/"}).get("Entries") or []
    require(isinstance(current, list), "Malformed current MFS listing")
    names = set()
    for entry in current:
        name = entry["Name"]
        require(name in entries, "Candidate MFS contains data outside this restore")
        require(call(FILE_STAT, {"arg": "/" + name, "hash": "true"})["Hash"] == entries[name]["Hash"], "Candidate MFS entry conflicts with this backup")
        names.add(name)
    return names


def restore_pins(saved, call):
    current = call(PIN_LIST, {"type": "all"})["Keys"]
    for cid, kind in saved["pins"].items():
        require(kind in ("recursive", "direct"), "Unsupported pin type")
        name = saved.get("pinNames", {}).get(cid, "")
        if current.get(cid, {}).get("Type") == kind and current[cid].get("Name", "") == name:
            continue
        query = {"arg": cid, "recursive": str(kind == "recursive").lower(), "name": name}
        call("pin/add", query, timeout=3600)


def restore_references(saved, call):
    require(saved.get("schema") == 1 and isinstance(saved.get("pins"), dict), "Unsupported backup format")
    entries = mfs_entries(saved, call)
    present = existing_mfs(entries, call)
    restore_pins(saved, call)
    for name in entries:
        if name not in present:
            call("files/cp", {"arg": ["/ipfs/" + saved["mfsRoot"] + "/" + name, "/" + name]})
    require(call(FILE_STAT, {"arg": "/", "hash": "true"})["Hash"] == saved["mfsRoot"], "Restored MFS root mismatch")


def download_backup(config, key, version):
    with tempfile.TemporaryDirectory() as directory:
        archive = Path(directory) / "metadata.tar.gz"
        result = aws("s3api", "get-object", "--region", config["region"], "--bucket", config["backupsBucket"], "--key", key,
                     "--version-id", version, str(archive))
        checksum = digest(archive, directory)
        require(checksum == result.get("Metadata", {}).get("sha256"), "Backup checksum mismatch")
        destination = Path(directory) / "state"
        destination.mkdir(mode=0o700)
        extract(archive, destination)
        saved = json.loads((destination / STATE_FILENAME).read_text())
    require(isinstance(saved, dict) and saved.get("schema") == 1 and isinstance(saved.get("pins"), dict), "Malformed backup manifest")
    require(isinstance(saved.get("pinNames", {}), dict), "Malformed backup pin names")
    require({"blocksBucket", "blockPrefix", "kuboVersion", "versions", "identity", "mfsRoot"}.issubset(saved), "Incomplete backup manifest")
    require(isinstance(saved["identity"], dict) and isinstance(saved["identity"].get("PeerID"), str), "Malformed backup identity")
    require(saved["blocksBucket"] == config["blocksBucket"] and saved["blockPrefix"] == "ipfs", "Restore points to different content storage")
    require(saved["kuboVersion"] == rpc("version")["Version"], "Restore using the matching Kubo release before upgrading")
    require(saved["versions"] == json.loads((ROOT / VERSIONS_FILENAME).read_text()), "Restore requires the matching pinned runtime build")
    require(saved["identity"]["PeerID"] != rpc("id")["ID"], "Candidate must have an independent node identity")
    return saved, checksum


def restore_session(config, key, version, checksum):
    path = SETTINGS / RESTORE_SESSION_FILENAME
    expected = {"backupKey": key, "backupVersion": version, "backupBucket": config["backupsBucket"],
                "backupSha256": checksum, "candidatePeerId": rpc("id")["ID"]}
    if path.exists():
        session = json.loads(path.read_text())
        require(isinstance(session, dict) and "bootstrapRoot" in session, "Malformed restore journal")
        require(all(session.get(k) == v for k, v in expected.items()), "Candidate restore belongs to a different backup or identity")
        return session
    require(not (rpc(MFS_LIST, {"arg": "/"}).get("Entries") or []), "Restore requires empty MFS")
    empty_root = rpc(FILE_STAT, {"arg": "/", "hash": "true"})["Hash"]
    pins = pin_inventory()
    require(not pins or pins == {empty_root: "recursive"}, "Restore requires an empty candidate; only the bootstrap directory pin is allowed")
    session = {**expected, "bootstrapRoot": empty_root, "status": "restoring"}
    write_private(path, session)
    return session


def verify_restored_pins(saved):
    entries = rpc(PIN_LIST, {"type": "all"})["Keys"]
    pins = {cid: entry["Type"] for cid, entry in entries.items() if entry["Type"] in ("recursive", "direct")}
    require(pins == saved["pins"], "Restored pins differ")
    require(all(entries[cid].get("Name", "") == name for cid, name in saved.get("pinNames", {}).items()), "Restored pin names differ")


def restore(config, key, version):
    candidate_guard(config)
    saved, checksum = download_backup(config, key, version)
    session = restore_session(config, key, version, checksum)
    initial_pins = pin_inventory()
    require(set(initial_pins).issubset(set(saved["pins"]) | {session["bootstrapRoot"]}), "Candidate has pins outside this restore")
    if session["bootstrapRoot"] in initial_pins and session["bootstrapRoot"] not in saved["pins"]:
        rpc("pin/rm", {"arg": session["bootstrapRoot"]})
    run("systemctl", "stop", "nginx")
    restore_references(saved, rpc)
    verify_restored_pins(saved)
    write_private(SETTINGS / RESTORE_SESSION_FILENAME, {**session, "status": "complete"})
    run("systemctl", "start", "nginx")
    return {"restoredPins": len(saved["pins"]), "mfsVerified": True, "independentIdentity": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["install", "verify", "backup", "restore", "seal"])
    parser.add_argument("--backup-key")
    parser.add_argument("--backup-version")
    args = parser.parse_args()
    require(os.geteuid() == 0, "Host operations require root")
    config = validate_config(json.loads((SETTINGS / "config.json").read_text()))
    candidate_guard(config, allow_active=args.operation in ("verify", "backup", "seal"))
    def seal():
        verify(config)
        (SETTINGS / "managed.json").write_text(json.dumps({"environment": config["environment"], "role": "active"}))
        return {"role": "active"}
    operations = {"install": lambda: install(config), "verify": lambda: verify(config),
                  "backup": lambda: backup(config), "restore": lambda: restore(config, args.backup_key, args.backup_version), "seal": seal}
    print(json.dumps({"protocol": RECEIPT_PROTOCOL, "operation": args.operation, "result": operations[args.operation]()}))


if __name__ == "__main__":
    main()
