"""Exercise the real release against disposable loopback S3 and HTTPS fixtures.

No AWS credentials, production data, resource provisioning, or public IPFS peers
are used. This is functional recovery evidence, not an AWS or load-test result.
"""
import hashlib
import http.server
import json
import os
import pwd
import signal
import socket
import subprocess
import sys
import tempfile
import tarfile
import io
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import host
from common import require


API_PATH = '/api/v0/'
LOOPBACK_HTTP = 'http://127.0.0.1:'
API_HOST = 'api.fixture'
ORIGIN_HOST = 'origin.fixture'
IPFS_PREFIX = '/ipfs/'
PAYLOAD_FILENAME = 'payload.bin'
FILE_STAT = 'files/stat'

class S3(http.server.BaseHTTPRequestHandler):
    objects = {}
    lock = threading.Lock()

    def log_message(self, *_args):
        # The disposable fixture does not log HTTP headers or payloads.
        pass

    def send(self, status, content=b"", head=False, kind="application/octet-stream"):
        self.send_response(status)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Content-Type", kind)
        self.end_headers()
        if not head:
            self.wfile.write(content)

    def do_PUT(self):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        data = self.rfile.read(int(self.headers["Content-Length"]))
        with self.lock:
            self.objects[path] = data
        self.send(200)

    def do_HEAD(self):
        self.read_object(head=True)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        if "list-type" in query:
            root = ET.Element("ListBucketResult", xmlns="http://s3.amazonaws.com/doc/2006-03-01/")  # NOSONAR: S3 XML namespace identifier, never a network request.
            ET.SubElement(root, "Name").text = "fixture-blocks"
            ET.SubElement(root, "IsTruncated").text = "false"
            prefix = query.get("prefix", [""])[0]
            with self.lock:
                for path, data in sorted(self.objects.items()):
                    key = path.split("/", 2)[-1]
                    if key.startswith(prefix):
                        item = ET.SubElement(root, "Contents")
                        ET.SubElement(item, "Key").text = key
                        ET.SubElement(item, "Size").text = str(len(data))
                        ET.SubElement(item, "LastModified").text = "2026-01-01T00:00:00.000Z"
                        ET.SubElement(item, "ETag").text = '"' + hashlib.sha256(data).hexdigest() + '"'
            self.send(200, ET.tostring(root), kind="application/xml")
        else:
            self.read_object()

    def read_object(self, head=False):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        with self.lock:
            data = self.objects.get(path)
        if data is None:
            self.send(404, b"<Error><Code>NoSuchKey</Code></Error>", head=head, kind="application/xml")
        else:
            self.send(200, data, head=head)


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def stop(process):
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


class Daemon:
    def __init__(self, binary, repo, endpoint, work):
        self.repo = repo
        self.binary = binary
        self.api_port = port()
        self.gateway_port = port()
        self.environment = {**os.environ, "IPFS_PATH": str(repo), "IPFS_TELEMETRY": "off", "DO_NOT_TRACK": "1", "AWS_EC2_METADATA_DISABLED": "true"}
        subprocess.run([str(binary), "init", "--profile=server", "--empty-repo"], env=self.environment,
                       capture_output=True, check=True, timeout=60)
        host.configure_repo({"region": "us-east-1", "blocksBucket": "fixture-blocks", "environment": "staging"}, repo, endpoint)
        path = repo / "config"
        config = json.loads(path.read_text())
        config["Addresses"]["API"] = "/ip4/127.0.0.1/tcp/" + str(self.api_port)
        config["Addresses"]["Gateway"] = "/ip4/127.0.0.1/tcp/" + str(self.gateway_port)
        config["Addresses"]["Swarm"] = []
        config["Bootstrap"] = []
        path.write_text(json.dumps(config))
        self.log = (work / (repo.name + ".log")).open("wb")
        self.process = None
        try:
            self.start()
            self.rpc("files/flush", {"arg": "/"})
            initial_root = self.rpc(FILE_STAT, {"arg": "/", "hash": "true"})["Hash"]
            require(self.rpc("block/get", {"arg": initial_root}, raw=True), "Bootstrap pin content is missing")
        except Exception:
            self.stop()
            self.log.close()
            raise

    def start(self):
        self.process = subprocess.Popen([str(self.binary), "daemon", "--offline", "--migrate=false"], env=self.environment,
                                        stdout=self.log, stderr=self.log)
        for _ in range(120):
            try:
                self.rpc("version", timeout=1)
                return
            except (OSError, ValueError):
                if self.process.poll() is not None:
                    print(Path(self.log.name).read_text()[-6000:], file=sys.stderr)
                require(self.process.poll() is None, "Fixture daemon failed; inspect its local log")
                time.sleep(0.25)
        raise TimeoutError("Fixture daemon did not start")

    def rpc(self, operation, query=None, raw=False, timeout=120):
        url = LOOPBACK_HTTP + str(self.api_port) + API_PATH + operation
        if query:
            url += "?" + urllib.parse.urlencode(query, doseq=True)
        with urllib.request.urlopen(urllib.request.Request(url, data=b"", method="POST"), timeout=timeout) as response:
            data = response.read()
        if raw:
            return data
        return json.loads(data) if data else {}

    def cli(self, *args):
        return subprocess.check_output([str(self.binary), *args], env=self.environment, timeout=120).decode().strip()

    def stop(self):
        if self.process:
            stop(self.process)


def https_rehearsal(bundle, work, daemon, payload, cid):
    package = work / "nginx-package"
    subprocess.run(["dpkg-deb", "-x", str(bundle / "nginx.deb"), str(package)], check=True)
    key, certificate = work / "key.pem", work / "cert.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", str(key),
                    "-out", str(certificate), "-subj", "/CN=origin.fixture", "-addext", "subjectAltName=DNS:origin.fixture,DNS:api.fixture"],
                   capture_output=True, check=True)
    tls_port = port()
    config = (bundle / "templates/nginx.conf").read_text()
    replacements = {
        "user www-data;": "user " + pwd.getpwuid(os.geteuid()).pw_name + ";", "/run/nginx.pid": str(work / "nginx.pid"),
        "/var/log/nginx/error.log": str(work / "nginx-error.log"),
        "/var/log/nginx/access.log": str(work / "nginx-access.log"),
        "/etc/nginx/mime.types": str(package / "etc/nginx/mime.types"),
        "/etc/letsencrypt/live/6529-ipfs/fullchain.pem": str(certificate),
        "/etc/letsencrypt/live/6529-ipfs/privkey.pem": str(key),
        "listen 443": "listen 127.0.0.1:" + str(tls_port),
        "@ORIGIN_HOST@": ORIGIN_HOST, "@API_HOST@": API_HOST,
        "127.0.0.1:5001": "127.0.0.1:" + str(daemon.api_port),
        "127.0.0.1:8080": "127.0.0.1:" + str(daemon.gateway_port),
    }
    for source, target in replacements.items():
        config = config.replace(source, target)
    config = config.replace("http {", "http {\n" + "\n".join(
        "    " + kind + "_temp_path " + str(work / (kind + "_temp")) + ";"
        for kind in ("client_body", "proxy", "fastcgi", "uwsgi", "scgi")))
    configuration = work / "nginx.conf"
    configuration.write_text(config)
    log = (work / "nginx-process.log").open("wb")
    process = subprocess.Popen([str(package / "usr/sbin/nginx"), "-c", str(configuration), "-p", str(work), "-e", str(work / "nginx-error.log"), "-g", "daemon off;"], stdout=log, stderr=log)

    def curl(name, path, *args):
        return subprocess.check_output(["curl", "--silent", "--show-error", "--noproxy", "*", "--cacert", str(certificate),
                                        "--resolve", name + ":" + str(tls_port) + ":127.0.0.1", *args,
                                        "https://" + name + ":" + str(tls_port) + path], timeout=120)
    try:
        for _ in range(60):
            try:
                with socket.create_connection(("127.0.0.1", tls_port), timeout=0.1):
                    break
            except OSError:
                if process.poll() is not None:
                    print((work / "nginx-process.log").read_text()[-6000:], file=sys.stderr)
                require(process.poll() is None, "nginx fixture failed to start")
                time.sleep(0.1)
        expected_version = json.loads((bundle / "versions.json").read_text())["kuboVersion"]
        require(json.loads(curl(API_HOST, "/health"))["Version"] == expected_version, "HTTPS health failed")
        require(curl(ORIGIN_HOST, IPFS_PREFIX + cid) == payload, "HTTPS content mismatch")
        require(curl(ORIGIN_HOST, IPFS_PREFIX + cid, "--range", "0-9") == payload[:10], "HTTPS range mismatch")
        require(curl(API_HOST, "/api/v0/version", "-X", "POST", "-o", "/dev/null", "-w", "%{http_code}") == b"403", "Restricted RPC exposed")
        require(curl(API_HOST, "/api/v0/files/cp", "-X", "POST", "-o", "/dev/null", "-w", "%{http_code}") == b"403", "MFS RPC exposed")
        uploaded = json.loads(curl(API_HOST, "/api/v0/add?pin=true", "-F", "file=@" + str(work / PAYLOAD_FILENAME), "-H", "Origin: https://staging.6529.io"))["Hash"]
        require(uploaded == cid, "HTTPS upload changed the CID")
        headers = curl(ORIGIN_HOST, IPFS_PREFIX + cid, "-I").decode().lower()
        require("content-length: " + str(len(payload)) in headers and "immutable" in headers, "HEAD/cache header mismatch")
    finally:
        stop(process)
        log.close()


def main():
    bundle = Path(sys.argv[1]).resolve()
    processes = []
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), S3)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    with tempfile.TemporaryDirectory(prefix="ipfs-recovery-") as directory:
        work = Path(directory)
        try:
            binary = bundle / "ipfs"
            first = Daemon(binary, work / "first", LOOPBACK_HTTP + str(server.server_port), work)
            processes.append(first)
            payload = bytes(range(256)) * 4096
            (work / PAYLOAD_FILENAME).write_bytes(payload)
            cid = first.cli("add", "-Q", str(work / PAYLOAD_FILENAME))
            first.rpc("files/cp", {"arg": [IPFS_PREFIX + cid, "/restored"]})
            first.rpc("files/mkdir", {"arg": "/nested"})
            first.rpc("files/cp", {"arg": [IPFS_PREFIX + cid, "/nested/payload"]})
            direct = first.cli("block", "put", "--format=raw", str(work / PAYLOAD_FILENAME))
            first.rpc("pin/add", {"arg": direct, "recursive": "false"})
            saved = {"schema": 1, "pins": {cid: "recursive", direct: "direct"},
                     "mfsRoot": first.rpc(FILE_STAT, {"arg": "/", "hash": "true"})["Hash"]}
            first_id = first.rpc("id")["ID"]
            https_rehearsal(bundle, work, first, payload, cid)
            first.stop()
            first.start()
            require(first.rpc("cat", {"arg": cid}, raw=True) == payload, "Restart lost content")
            require(first.rpc(FILE_STAT, {"arg": "/", "hash": "true"})["Hash"] == saved["mfsRoot"], "Restart lost MFS")
            # Exercise the actual backup/restore implementation. Only the S3
            # transport and systemd calls are replaced; the private archive,
            # version selection, checksum, RPC state and recovery are real.
            config = {"environment": "staging", "region": "us-east-1", "blocksBucket": "fixture-blocks", "backupsBucket": "fixture-backups"}
            host.SETTINGS = work / "first-settings"
            archive = {}
            def aws_fixture(*args):
                if args[:2] == ("s3api", "put-object"):
                    require(args[args.index("--server-side-encryption") + 1] == "AES256", "Backup encryption missing")
                    archive["body"] = Path(args[args.index("--body") + 1]).read_bytes()
                    archive["metadata"] = json.loads(args[args.index("--metadata") + 1])
                    return {"VersionId": "fixture-backup-version"}
                require(args[:2] == ("s3api", "get-object"), "Unexpected fixture AWS call")
                require(args[args.index("--version-id") + 1] == "fixture-backup-version", "Restore did not select the recorded version")
                Path(args[-1]).write_bytes(archive["body"])
                return {"Metadata": archive["metadata"]}
            host.aws = aws_fixture
            host.API = LOOPBACK_HTTP + str(first.api_port) + API_PATH
            host.REPO = first.repo
            receipt = host.backup(config)
            with tarfile.open(fileobj=io.BytesIO(archive["body"]), mode="r:gz") as source:
                metadata = source.extractfile("state.json").read().decode()
            require('"secretKey"' not in metadata and '"accessKey"' not in metadata, "Backup leaked runtime credentials")
            first.stop()
            second = Daemon(binary, work / "second", LOOPBACK_HTTP + str(server.server_port), work)
            processes.append(second)
            require(second.rpc("id")["ID"] != first_id, "Restore reused the source identity")
            host.API = LOOPBACK_HTTP + str(second.api_port) + API_PATH
            host.REPO = second.repo
            host.SETTINGS = work / "settings"
            host.SETTINGS.mkdir()
            (host.SETTINGS / "managed.json").write_text(json.dumps({"environment": "staging", "role": "candidate"}))
            def systemd_fixture(*args):
                require(args in (("systemctl", "stop", "nginx"), ("systemctl", "start", "nginx")), "Unexpected fixture host mutation")
            host.run = systemd_fixture
            real_rpc = host.rpc
            copies = 0
            def interrupted_rpc(operation, *args, **kwargs):
                nonlocal copies
                if operation == "files/cp":
                    copies += 1
                    if copies == 2:
                        raise ConnectionError("Synthetic interrupted restore")
                return real_rpc(operation, *args, **kwargs)
            host.rpc = interrupted_rpc
            try:
                host.restore(config, receipt["backupKey"], receipt["versionId"])
            except ConnectionError:
                require(copies == 2, "Wrong simulated failure point")
            else:
                raise AssertionError("Restore interruption was not exercised")
            finally:
                host.rpc = real_rpc
            host.restore(config, receipt["backupKey"], receipt["versionId"])
            host.restore(config, receipt["backupKey"], receipt["versionId"])
            pins = second.rpc("pin/ls", {"type": "all"})["Keys"]
            require(all(pins[cid]["Type"] == kind for cid, kind in saved["pins"].items()), "Restore lost pin types")
            for root_cid, entry in pins.items():
                if entry["Type"] in ("recursive", "direct"):
                    require(second.rpc("block/get", {"arg": root_cid}, raw=True), "Restored pin content is missing")
            require(second.rpc("cat", {"arg": cid}, raw=True) == payload, "Restored content differs")
            second.stop()
            second.start()
            require(second.rpc(FILE_STAT, {"arg": "/", "hash": "true"})["Hash"] == saved["mfsRoot"], "Restored MFS did not persist")
            print(json.dumps({"passed": True, "checks": ["bundled-s3-startup", "bootstrap-pin-content", "all-restored-pin-root-blocks", "multi-chunk-upload", "recursive-and-direct-pins", "mfs-nested-directories", "restart-persistence", "independent-identity", "private-logical-backup", "versioned-checksummed-restore", "pin-and-mfs-restoration", "interrupted-restore-resume", "idempotent-restore", "restored-restart", "nginx-https", "range", "head", "restricted-rpc", "https-upload"], "awsResourcesCreated": 0}))
        finally:
            for daemon in processes:
                daemon.stop()
                daemon.log.close()
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
