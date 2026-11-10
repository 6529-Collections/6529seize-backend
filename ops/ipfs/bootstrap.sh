#!/bin/bash
# Executed only by the explicit Actions controller on a tagged new candidate.
set -euo pipefail
umask 077
python3 - <<'PY'
import base64,json,os,pathlib,subprocess
config=json.loads(base64.b64decode(os.environ['IPFS_CONFIG_BASE64']))
marker=json.loads(pathlib.Path('/etc/6529-ipfs/managed.json').read_text())
if marker != {'environment':config['environment'],'role':'candidate'}:
    raise SystemExit('Not a managed candidate')
if subprocess.run(['systemctl','is-active','ipfs'],capture_output=True).returncode == 0:
    raise SystemExit('Daemon already active; use verify or a fresh candidate. No restart performed.')
PY
release_dir="/opt/6529-ipfs/releases/$IPFS_SOURCE_SHA"
test ! -e "$release_dir"
install -d -m 700 "$release_dir"
trap 'rm -f "$release_dir/bundle.tar.gz"' EXIT
aws s3api get-object --region "$IPFS_REGION" --bucket "$IPFS_ARTIFACT_BUCKET" --key "$IPFS_ARTIFACT_KEY" \
  --version-id "$IPFS_ARTIFACT_VERSION" "$release_dir/bundle.tar.gz" >/dev/null
python3 - "$release_dir" <<'PY'
import hashlib,json,os,pathlib,tarfile
root=pathlib.Path(__import__('sys').argv[1]);archive=root/'bundle.tar.gz'
if hashlib.sha256(archive.read_bytes()).hexdigest()!=os.environ['IPFS_BUNDLE_SHA256']:
    raise SystemExit('Bundle integrity check failed')
with tarfile.open(archive,'r:gz') as source:
    entries=source.getmembers()
    if sum(x.size for x in entries)>600*1024*1024:
        raise SystemExit('Bundle too large')
    for entry in entries:
        if not (entry.isfile() or entry.isdir()) or entry.name.startswith('/') or not (root/entry.name).resolve().is_relative_to(root):
            raise SystemExit('Unsafe bundle entry')
    source.extractall(root,members=entries,filter='data')
manifest=json.loads((root/'release.json').read_text())
if manifest['sourceSha']!=os.environ['IPFS_SOURCE_SHA']:
    raise SystemExit('Bundle source mismatch')
for filename,checksum in manifest['files'].items():
    path=(root/filename).resolve()
    if not path.is_relative_to(root) or hashlib.sha256(path.read_bytes()).hexdigest()!=checksum:
        raise SystemExit('Release file integrity check failed')
config=pathlib.Path('/etc/6529-ipfs/config.json')
config.write_bytes(__import__('base64').b64decode(os.environ['IPFS_CONFIG_BASE64']))
config.chmod(0o600)
PY
chmod 755 "$release_dir/ipfs"
# The daemon runs as ipfs. Only non-secret release assets live here; private
# configuration and metadata remain in the root-private /etc directory and the
# service user's private repository. A 0700 release ancestor would prevent exec.
chmod 755 /opt/6529-ipfs /opt/6529-ipfs/releases "$release_dir"
ln -s "$release_dir" /opt/6529-ipfs/current
python3 /opt/6529-ipfs/current/host.py install
