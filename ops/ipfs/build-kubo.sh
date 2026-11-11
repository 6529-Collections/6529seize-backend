#!/bin/bash
# Build on an ephemeral Linux amd64 runner; never on the serving IPFS instance.
set -euo pipefail
ipfs_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ipfs_build="$(mktemp -d)"
trap 'rm -rf "$ipfs_build"' EXIT
[[ "$(uname -s)" = Linux ]]
[[ "$(uname -m)" = x86_64 ]]
[[ "${IPFS_SOURCE_SHA:-}" = "$(git -C "$ipfs_root" rev-parse HEAD)" ]]
read_version() {
  local version_key="$1"
  python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$ipfs_root/versions.json" "$version_key"
}
go_version="$(read_version goVersion)"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://go.dev/dl/go$go_version.linux-amd64.tar.gz" -o "$ipfs_build/go.tar.gz"
printf '%s  %s\n' "$(read_version goLinuxAmd64Sha256)" "$ipfs_build/go.tar.gz" | sha256sum -c -
tar -xzf "$ipfs_build/go.tar.gz" -C "$ipfs_build"
export PATH="$ipfs_build/go/bin:$PATH" GOTOOLCHAIN=local CGO_ENABLED=1
export GOFLAGS=-trimpath
export IPFS_TELEMETRY=off DO_NOT_TRACK=1
[[ -z "$(gofmt -l "$ipfs_root/router/main.go")" ]]
git init -q "$ipfs_build/kubo"
git -C "$ipfs_build/kubo" remote add origin https://github.com/ipfs/kubo.git
git -C "$ipfs_build/kubo" fetch --depth=1 origin "$(read_version kuboCommit)"
git -C "$ipfs_build/kubo" checkout --detach FETCH_HEAD
[[ "$(git -C "$ipfs_build/kubo" rev-parse HEAD)" = "$(read_version kuboCommit)" ]]
pushd "$ipfs_build/kubo" >/dev/null
go get "github.com/ipfs/go-ds-s3@$(read_version s3Commit)"
# The reviewed patch adds a validation mode that never writes S3: Kubo's
# initialization Put is accepted only when the existing bytes already match.
s3_source="$(go mod download -json "github.com/ipfs/go-ds-s3@$(read_version s3Commit)" | python3 -c 'import json,sys;print(json.load(sys.stdin)["Dir"])')"
cp -R "$s3_source" "$ipfs_build/s3"
chmod -R u+w "$ipfs_build/s3"
git -C "$ipfs_build/s3" init -q
git -C "$ipfs_build/s3" apply --check "$ipfs_root/s3-read-only.patch"
git -C "$ipfs_build/s3" apply "$ipfs_root/s3-read-only.patch"
go mod edit -replace "github.com/ipfs/go-ds-s3=$ipfs_build/s3"
printf '\ns3ds github.com/ipfs/go-ds-s3/plugin *\n' >> plugin/loader/preload_list
bash plugin/loader/preload.sh > plugin/loader/preload.go
go fmt ./plugin/loader
make mod_tidy
go mod verify
make build
[[ "$(./cmd/ipfs/ipfs version --number)" = "$(read_version kuboVersion)" ]]
popd >/dev/null
destination="${IPFS_BUILD_OUTPUT:?IPFS_BUILD_OUTPUT is required}"
mkdir -p "$destination"
cp "$ipfs_build/kubo/cmd/ipfs/ipfs" "$destination/ipfs"
GO111MODULE=off go build -trimpath -o "$destination/upload-router" "$ipfs_root/router/main.go"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://nginx.org/packages/ubuntu/pool/nginx/n/nginx/nginx_$(read_version nginxVersion)_amd64.deb" -o "$destination/nginx.deb"
printf '%s  %s\n' "$(read_version nginxDebSha256)" "$destination/nginx.deb" | sha256sum -c -
cp "$ipfs_root/production_host.py" "$destination/"
cp "$ipfs_root/host.py" "$ipfs_root/common.py" "$ipfs_root/versions.json" "$destination/"
cp "$ipfs_root/s3-read-only.patch" "$destination/"
cp "$ipfs_root/handover_state.py" "$destination/"
cp -R "$ipfs_root/templates" "$ipfs_root/environments" "$destination/"
IPFS_BUILD_OUTPUT="$destination" python3 - <<'PY'
import hashlib,json,os,pathlib
root=pathlib.Path(os.environ['IPFS_BUILD_OUTPUT'])
files={str(path.relative_to(root)):hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(root.rglob('*')) if path.is_file() and path.name!='release.json'}
manifest={'sourceSha':os.environ['IPFS_SOURCE_SHA'],'versions':json.loads((root/'versions.json').read_text()),'ipfsSha256':files['ipfs'],'files':files}
(root/'release.json').write_text(json.dumps(manifest,indent=2))
PY
