#!/usr/bin/env bash
# Prepares the Sentry host. Idempotent; run as root through scripts/run-on-host.sh.
#   - formats (first run only) and mounts the data volume at /srv
#   - adds an 8 GiB swap file on /srv
#   - installs Docker Engine and the Compose plugin from Docker's signed apt repo,
#     with the Docker data root on /srv
#   - installs the AWS CLI (snap) and starts the CloudWatch agent with
#     host/cloudwatch-agent.json when the agent package is present
# Required environment: DATA_VOLUME_ID (vol-...).
set -euo pipefail

: "${DATA_VOLUME_ID:?DATA_VOLUME_ID is required}"
here="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive

# Docker's release signing key (https://docs.docker.com/engine/install/ubuntu/).
DOCKER_KEY_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

log() { printf '[bootstrap-host] %s\n' "$*"; }

# --- data volume -------------------------------------------------------------
device="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${DATA_VOLUME_ID//-/}"
for _ in $(seq 1 60); do
  [[ -e "$device" ]] && break
  sleep 5
done
[[ -e "$device" ]] || { log "data volume $DATA_VOLUME_ID is not attached"; exit 1; }

if ! blkid "$device" >/dev/null 2>&1; then
  log "formatting $DATA_VOLUME_ID (first run)"
  mkfs.ext4 -q -L sentry-data "$device"
fi
uuid="$(blkid -s UUID -o value "$device")"
mkdir -p /srv
if ! grep -q "UUID=$uuid" /etc/fstab; then
  echo "UUID=$uuid /srv ext4 defaults,noatime,nofail,x-systemd.device-timeout=60 0 2" >>/etc/fstab
fi
mountpoint -q /srv || mount /srv
mountpoint -q /srv || { log "/srv is not mounted"; exit 1; }

# --- swap --------------------------------------------------------------------
if [[ ! -f /srv/swapfile ]]; then
  fallocate -l 8G /srv/swapfile
  chmod 600 /srv/swapfile
  mkswap /srv/swapfile >/dev/null
fi
grep -q '^/srv/swapfile ' /etc/fstab || echo '/srv/swapfile none swap sw,nofail 0 0' >>/etc/fstab
swapon --show=NAME --noheadings | grep -qx /srv/swapfile || swapon /srv/swapfile
echo 'vm.swappiness=10' >/etc/sysctl.d/90-sentry-selfhost.conf
sysctl -q --system

# --- packages ----------------------------------------------------------------
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git jq

install -m 0755 -d /etc/apt/keyrings
key_tmp="$(mktemp)"
curl --proto '=https' --tlsv1.2 -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$key_tmp"
actual_fpr="$(gpg --show-keys --with-colons "$key_tmp" | awk -F: '/^fpr:/ {print $10; exit}')"
if [[ "$actual_fpr" != "$DOCKER_KEY_FINGERPRINT" ]]; then
  log "unexpected Docker signing key fingerprint: $actual_fpr"
  exit 1
fi
install -m 0644 "$key_tmp" /etc/apt/keyrings/docker.asc
rm -f "$key_tmp"
codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" \
  >/etc/apt/sources.list.d/docker.list

mkdir -p /etc/docker /etc/systemd/system/docker.service.d
cat >/etc/docker/daemon.json <<'JSON'
{
  "data-root": "/srv/docker",
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "3" }
}
JSON
cat >/etc/systemd/system/docker.service.d/10-sentry-selfhost.conf <<'UNIT'
[Unit]
RequiresMountsFor=/srv
UNIT
apt-get update -q
apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl daemon-reload
systemctl enable --now docker
systemctl restart docker

if ! command -v aws >/dev/null 2>&1; then
  snap install aws-cli --classic
fi

# --- CloudWatch agent (package installed with AWS-ConfigureAWSPackage) --------
ctl=/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl
if [[ -x "$ctl" ]]; then
  install -m 0644 "$here/cloudwatch-agent.json" /opt/aws/amazon-cloudwatch-agent/etc/sentry-selfhost.json
  "$ctl" -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/sentry-selfhost.json >/dev/null
  log "CloudWatch agent: $("$ctl" -a status | jq -r .status)"
else
  log "CloudWatch agent package not installed yet; run AWS-ConfigureAWSPackage first"
fi

log "kernel $(uname -r); $(docker --version); $(docker compose version)"
log "/srv: $(df -h --output=size,used,avail /srv | tail -1)"
log "done"
