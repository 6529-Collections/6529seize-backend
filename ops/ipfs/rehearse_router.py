"""Run the real upload router through handover, draining and mutable-write fencing.

All services and TLS certificates are disposable. The private peer address is
local to the runner; no AWS account, credentials or production data are used.
"""
import concurrent.futures
import http.client
import http.server
import ipaddress
import json
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from common import require


def available_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def private_address():
    for result in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
        address = result[4][0]
        value = ipaddress.ip_address(address)
        if value.is_private and not value.is_loopback:
            return address
    raise ValueError("Router rehearsal requires a private runner address")


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=10)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(str(self.path))


def control(path, state=None, expected_status=200):
    connection = UnixConnection(path)
    body = json.dumps(state).encode() if state else None
    connection.request("POST" if state else "GET", "/state", body=body)
    response = connection.getresponse()
    data = response.read()
    connection.close()
    require(response.status == expected_status, "Unexpected control result")
    return json.loads(data) if response.status == 200 else None


class Backend(http.server.BaseHTTPRequestHandler):
    slow_started = threading.Event()
    release_slow = threading.Event()
    accepted = []
    lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if "slow=true" in self.path:
            self.slow_started.set()
            require(self.release_slow.wait(20), "Slow fixture was not released")
        with self.lock:
            self.accepted.append((self.server.identity, body))
        output = json.dumps({"Hash": self.server.identity, "Size": len(body)}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(output)))
        self.end_headers()
        self.wfile.write(output)


class TLSProxy(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        request = urllib.request.Request(self.server.destination + self.path, data=body, headers={"X-6529-IPFS-Hop": self.headers.get("X-6529-IPFS-Hop", "")})
        with urllib.request.urlopen(request, timeout=20) as response:
            data = response.read()
            self.send_response(response.status)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)


def upload(port, query="", payload=b"accepted-upload"):
    request = urllib.request.Request("http://127.0.0.1:" + str(port) + "/api/v0/add" + query, data=payload)
    with urllib.request.urlopen(request, timeout=30) as response:
        require(response.status == 200, "Upload was rejected during handover")
        return json.loads(response.read())


def main():
    binary = Path(sys.argv[1]) / "upload-router"
    processes, servers = [], []
    with tempfile.TemporaryDirectory(prefix="ipfs-router-") as directory:
        root = Path(directory)
        try:
            sockets, ports = {}, {}
            for identity in ("source", "target"):
                backend = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Backend)
                backend.identity = identity
                servers.append(backend)
                threading.Thread(target=backend.serve_forever, daemon=True).start()
                state = root / (identity + ".json")
                state.write_text(json.dumps({"mode": "serve", "epoch": 0, "mfsReady": identity == "source"}))
                ports[identity] = available_port()
                sockets[identity] = root / (identity + ".sock")
                command = [str(binary), "--listen", "127.0.0.1:" + str(ports[identity]), "--upstream", "http://127.0.0.1:" + str(backend.server_port),
                           "--control", str(sockets[identity]), "--state", str(state), "--node-id", identity, "--source-sha", "a" * 40]
                process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                processes.append(process)
                for _ in range(100):
                    if sockets[identity].exists():
                        break
                    require(process.poll() is None, "Router failed to start")
                    time.sleep(0.05)
                control(sockets[identity])
            key, cert = root / "key.pem", root / "cert.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", str(key), "-out", str(cert),
                            "-subj", "/CN=api-ipfs.6529.io", "-addext", "subjectAltName=DNS:api-ipfs.6529.io"], capture_output=True, check=True)
            address = private_address()
            tls = http.server.ThreadingHTTPServer((address, 0), TLSProxy)
            tls.destination = "http://127.0.0.1:" + str(ports["target"])
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            tls.socket = context.wrap_socket(tls.socket, server_side=True)
            servers.append(tls)
            threading.Thread(target=tls.serve_forever, daemon=True).start()
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                old = pool.submit(upload, ports["source"], "?slow=true", b"old-in-flight")
                require(Backend.slow_started.wait(5), "Old request did not start")
                status = control(sockets["source"], {"expectedEpoch": 0, "state": {"mode": "forward", "epoch": 1, "mfsReady": True,
                                 "target": "https://" + address + ":" + str(tls.server_port), "targetNodeId": "target", "certificate": cert.read_text()}})
                require(status["localActive"] == 1, "Old request was not tracked through the fence")
                require(upload(ports["source"])["Hash"] == "target", "New request used the old writer")
                mutable = pool.submit(upload, ports["source"], "?to-files=/pending", b"new-mutable-upload")
                for _ in range(100):
                    if control(sockets["target"])["waitingMfs"] == 1:
                        break
                    time.sleep(0.02)
                require(not mutable.done(), "Mutable upload bypassed the final-state fence")
                require(upload(ports["source"])["Hash"] == "target", "Immutable uploads were blocked by mutable-state transfer")
                Backend.release_slow.set()
                require(old.result()["Hash"] == "source", "Accepted old upload was interrupted or replayed")
                require(control(sockets["source"])["localActive"] == 0, "Source did not drain")
                control(sockets["target"], {"expectedEpoch": 0, "state": {"mode": "serve", "epoch": 1, "mfsReady": True}})
                require(mutable.result()["Hash"] == "target", "Held mutable upload did not complete")
            # Epoch checks stop an interrupted/older controller from undoing a fence.
            control(sockets["source"], {"expectedEpoch": 0, "state": {"mode": "serve", "epoch": 1, "mfsReady": True}}, expected_status=409)
            require(Backend.accepted.count(("source", b"old-in-flight")) == 1, "Old upload was duplicated")
            # Reverse the exact protocol: the original host is prepared first,
            # then the current writer forwards and drains. New writes survive.
            reverse_tls = http.server.ThreadingHTTPServer((address, 0), TLSProxy)
            reverse_tls.destination = "http://127.0.0.1:" + str(ports["source"])
            reverse_tls.socket = context.wrap_socket(reverse_tls.socket, server_side=True)
            servers.append(reverse_tls)
            threading.Thread(target=reverse_tls.serve_forever, daemon=True).start()
            control(sockets["source"], {"expectedEpoch": 1, "state": {"mode": "serve", "epoch": 2, "mfsReady": False}})
            Backend.slow_started.clear()
            Backend.release_slow.clear()
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                accepted = pool.submit(upload, ports["target"], "?slow=true", b"accepted-before-rollback")
                require(Backend.slow_started.wait(5), "Rollback source request did not start")
                control(sockets["target"], {"expectedEpoch": 1, "state": {"mode": "forward", "epoch": 2, "mfsReady": True,
                                         "target": "https://" + address + ":" + str(reverse_tls.server_port), "targetNodeId": "source", "certificate": cert.read_text()}})
                require(upload(ports["target"])["Hash"] == "source", "Rollback used the wrong writer")
                mutable = pool.submit(upload, ports["target"], "?to-files=/rollback", b"mutable-during-rollback")
                for _ in range(100):
                    if control(sockets["source"])["waitingMfs"] == 1:
                        break
                    time.sleep(0.02)
                require(not mutable.done(), "Rollback mutable fence was bypassed")
                Backend.release_slow.set()
                require(accepted.result()["Hash"] == "target", "Rollback interrupted an accepted upload")
                require(control(sockets["target"])["localActive"] == 0, "Rollback source did not drain")
                control(sockets["source"], {"expectedEpoch": 2, "state": {"mode": "serve", "epoch": 3, "mfsReady": True}})
                require(mutable.result()["Hash"] == "source", "Rollback did not release its mutable upload")
            require(Backend.accepted.count(("target", b"accepted-before-rollback")) == 1, "Rollback duplicated an accepted upload")
            require(all(path.stat().st_mode & 0o777 == 0o600 for path in sockets.values()), "Control socket is not private")
            print(json.dumps({"passed": True, "checks": ["synchronous-upload-forwarding", "accepted-request-draining", "mutable-upload-fence", "immutable-upload-continuity", "stale-controller-rejected", "verified-private-tls-peer", "rollback-with-concurrent-uploads", "root-only-control-sockets"], "awsResourcesCreated": 0}))
        finally:
            Backend.release_slow.set()
            for process in processes:
                process.terminate()
                process.wait(timeout=10)
            for server in servers:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    main()
