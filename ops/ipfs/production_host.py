"""Root-only production operations, invoked by the reviewed Actions controller.

Private recovery archives never leave S3/SSM. Transfer objects contain public CIDs,
pin names and allowlisted serving settings, never a private peer identity.
"""
import base64
import datetime
import hashlib
import http.client
import ipaddress
import json
import os
import pwd
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

import host
from common import ROOT, aws, digest, require, write_private
from handover_state import merge_pins, replace_fenced_mfs, snapshot, state_hash

SETTINGS = Path('/etc/6529-ipfs')
CONTEXT = json.loads((ROOT / 'environments/production-deployment.json').read_text())
SOCKET = '/run/6529-ipfs-router/control.sock'
ROUTER_STATE = 'router-state.json'
JSON_SUFFIX = '.json'
IPFS_UNIT = Path('/etc/systemd/system/ipfs.service')
NGINX_DIRECTORY = Path('/etc/nginx')
IPFS_PREFIX = '/ipfs/'
METADATA = 'http://169.254.169.254/latest/' # NOSONAR(S1313) AWS IMDSv2 fixed link-local endpoint, never a public host.


class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        import socket
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(SOCKET)


def router(state=None):
    connection = UnixConnection('localhost', timeout=10)
    connection.request('POST' if state else 'GET', '/state', body=json.dumps(state) if state else None,
                       headers={'Content-Type': 'application/json'})
    response = connection.getresponse()
    require(response.status == 200, 'Router state changed or was rejected; reconcile its persisted epoch')
    result = json.loads(response.read())
    connection.close()
    return result


def set_router(mode, ready, target=None):
    previous = router()
    desired = {'mode': mode, 'mfsReady': ready}
    if target:
        desired.update(target='https://' + str(ipaddress.IPv4Address(target['privateIp'])) + ':443',
                       targetNodeId=target['instanceId'], certificate=target['certificate'])
    persisted = json.loads((SETTINGS / ROUTER_STATE).read_text())
    if all(persisted.get(k) == v for k, v in desired.items()) and (mode == 'forward' or not persisted.get('target')):
        return previous
    desired['epoch'] = previous['epoch'] + 1
    return router({'expectedEpoch': previous['epoch'], 'state': desired})


def node_identity():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(METADATA + 'api/token', data=b'', method='PUT',
                                     headers={'X-aws-ec2-metadata-token-ttl-seconds': '60'})
    token = opener.open(request, timeout=5).read().decode()
    request = urllib.request.Request(METADATA + 'meta-data/instance-id',
                                     headers={'X-aws-ec2-metadata-token': token})
    return opener.open(request, timeout=5).read().decode()


def is_legacy(node):
    return node == CONTEXT['legacyInstanceId']


def repo(node):
    return Path('/home/ubuntu/.ipfs') if is_legacy(node) else host.REPO


def private_upload(path, key):
    result = aws('s3api', 'put-object', '--region', CONTEXT['region'], '--bucket', CONTEXT['backupsBucket'],
                 '--key', key, '--body', str(path), '--server-side-encryption', 'AES256', timeout=900)
    require(result.get('VersionId') not in (None, 'null'), 'Recovery storage must be versioned')
    return {'key': key, 'version': result['VersionId'], 'sha256': digest(path, path.parent)}


def save_transfer(node, saved, label):
    require(label and all(c.isalnum() or c in '-_' for c in label), 'Invalid transfer label')
    config = json.loads((repo(node) / 'config').read_text())
    serving = {'apiHeaders': {k: v for k, v in config.get('API', {}).get('HTTPHeaders', {}).items()
                             if k in ('Access-Control-Allow-Origin', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Headers')},
               'gateway': {k: v for k, v in config.get('Gateway', {}).items()
                           if k in ('NoFetch', 'NoDNSLink', 'PublicGateways', 'RootRedirect', 'HTTPHeaders')}}
    value = {**saved, 'sourceInstanceId': node, 'sourcePeerId': host.rpc('id')['ID'],
             'serving': serving, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    path = SETTINGS / ('transfer-' + label + JSON_SUFFIX)
    write_private(path, value)
    result = private_upload(path, 'prod/transfers/' + node + '/' + label + '-' + state_hash(value) + JSON_SUFFIX)
    return {**result, 'pinCount': len(saved['pins']), 'mfsRoot': saved['mfsRoot']}


def read_transfer(reference):
    require(reference['key'].startswith('prod/transfers/') and '..' not in reference['key'], 'Invalid transfer key')
    require(reference.get('version') not in (None, 'null'), 'Exact transfer version required')
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / 'transfer.json'
        aws('s3api', 'get-object', '--region', CONTEXT['region'], '--bucket', CONTEXT['backupsBucket'],
            '--key', reference['key'], '--version-id', reference['version'], str(path))
        require(digest(path, path.parent) == reference['sha256'], 'Transfer checksum mismatch')
        return json.loads(path.read_text())


def backup(node, request):
    unit = IPFS_UNIT.read_text()
    require('--enable-gc' not in unit, 'Disable automatic content GC through a reviewed migration before handover')
    saved = snapshot(host.rpc)
    transfer = save_transfer(node, saved, request['label'])
    # An identity/config recovery archive complements logical state; copying an
    # open LevelDB is deliberately excluded. Archive permissions remain private.
    with tempfile.TemporaryDirectory() as temporary:
        archive = Path(temporary) / 'recovery.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            for path in (repo(node) / 'config', repo(node) / 'keystore', repo(node) / 'datastore_spec',
                         repo(node) / 'version', NGINX_DIRECTORY, Path('/etc/letsencrypt'),
                         IPFS_UNIT, SETTINGS):
                if path.exists():
                    output.add(path, arcname=str(path).lstrip('/'))
        prefix = 'legacy' if is_legacy(node) else 'runtime'
        recovery = private_upload(archive, 'prod/private/' + prefix + '/' + node + '/' + request['label'] + '.tar.gz')
    return {'transfer': transfer, 'recovery': recovery, 'privateIdentityBackedUp': True}


def verify_release(sha):
    manifest = json.loads((ROOT / 'release.json').read_text())
    require(manifest['sourceSha'] == sha, 'Release source mismatch')
    for name, expected in manifest['files'].items():
        require(digest(ROOT / name, ROOT) == expected, 'Release file checksum mismatch')
    return manifest


def router_service(node, sha, ready):
    SETTINGS.mkdir(mode=0o700, parents=True, exist_ok=True)
    state_path = SETTINGS / ROUTER_STATE
    if not state_path.exists():
        write_private(state_path, {'mode': 'serve', 'epoch': 0, 'mfsReady': ready})
    if Path(SOCKET).exists():
        existing = router()
        require(existing['nodeId'] == node, 'Router identity mismatch')
        return existing
    unit = (ROOT / 'templates/upload-router.service').read_text()
    for key, value in {'RELEASE': str(ROOT), 'NODE': node, 'SHA': sha}.items():
        unit = unit.replace('@' + key + '@', value)
    Path('/etc/systemd/system/6529-ipfs-router.service').write_text(unit)
    host.run('systemctl', 'daemon-reload')
    host.run('systemctl', 'enable', '--now', '6529-ipfs-router')
    for _ in range(30):
        try:
            status = router()
            require(status['nodeId'] == node and status['sourceSha'] == sha, 'Router source mismatch')
            return status
        except OSError:
            time.sleep(1)
    raise TimeoutError('Upload router did not start')


def install(node, request):
    require(not is_legacy(node), 'Never install Kubo on the legacy production server')
    marker = json.loads((SETTINGS / 'managed.json').read_text())
    require(marker['role'] == 'candidate', 'Installation requires an unused replacement')
    receipt = SETTINGS / 'installed.json'
    if receipt.exists():
        require(json.loads(receipt.read_text())['sourceSha'] == request['sha'], 'Immutable runtime already belongs to another release')
        return status(node)
    require(not (host.REPO / 'config').exists(), 'Partial installation requires inspection; never erase an initialized repository')
    host.stopped()
    try:
        pwd.getpwnam('ipfs')
    except KeyError:
        host.run('useradd', '--system', '--home-dir', str(host.REPO), '--shell', '/usr/sbin/nologin', 'ipfs')
    host.REPO.mkdir(mode=0o700, parents=True, exist_ok=True)
    host.ownership()
    host.run(str(ROOT / 'ipfs'), 'init', '--profile=server', '--empty-repo', user=True)
    config = {'region': CONTEXT['region'], 'blocksBucket': CONTEXT['blocksBucket'], 'readOnly': True}
    host.configure_repo(config)
    saved = read_transfer(request['transfer'])
    path = host.REPO / 'config'
    data = json.loads(path.read_text())
    data['API']['HTTPHeaders'] = saved['serving']['apiHeaders']
    data['Gateway'].update(saved['serving']['gateway'])
    path.write_text(json.dumps(data)); path.chmod(0o600)
    host.ownership()
    host.run('systemctl', 'mask', 'nginx')
    host.run('apt-get', '-o', 'Acquire::Retries=3', 'install', '-y', '--no-install-recommends', 'libpcre2-8-0', 'libssl3t64', 'zlib1g', timeout=900)
    host.run('dpkg', '-i', str(ROOT / 'nginx.deb'))
    tls = SETTINGS / 'tls'; tls.mkdir(mode=0o700, exist_ok=True)
    host.run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
             '-keyout', str(tls / 'key.pem'), '-out', str(tls / 'cert.pem'), '-subj', '/CN=api-ipfs.6529.io',
             '-addext', 'subjectAltName=DNS:api-ipfs.6529.io,DNS:ipfs-origin.6529.io')
    (tls / 'key.pem').chmod(0o600)
    unit = (ROOT / 'templates/ipfs.service').read_text().replace('/opt/6529-ipfs/current', str(ROOT))
    IPFS_UNIT.write_text(unit)
    host.run('systemctl', 'daemon-reload'); host.run('systemctl', 'enable', '--now', 'ipfs')
    host.wait_ready()
    require(host.rpc('id')['ID'] != saved['sourcePeerId'], 'Replacement must have an independent identity')
    router_service(node, request['sha'], False)
    write_private(receipt, {'sourceSha': request['sha'], 'transfer': request['transfer']})
    configure_nginx(node, request)
    return status(node)


def restore_read_only(node, request):
    require(not is_legacy(node) and read_only(node), 'Read-only restore requires a read-only replacement')
    saved = read_transfer(request['transfer'])
    count = merge_pins(saved, host.rpc)
    # pin/add traverses the full DAG; also prove the immutable MFS root is readable.
    host.rpc('ls', {'arg': IPFS_PREFIX + saved['mfsRoot']}, timeout=1800)
    write_private(SETTINGS / 'read-only-verified.json', {'transfer': request['transfer'], 'pinCount': count})
    return {'readOnlyVerified': True, 'pinCount': count, 'mfsRoot': saved['mfsRoot']}


def read_only(node):
    spec = json.loads((repo(node) / 'config').read_text())['Datastore']['Spec']
    return next(m['child'] for m in spec['mounts'] if m['mountpoint'] == '/blocks').get('readOnly', False)


def enable_writes(node, request):
    require(not is_legacy(node), 'Never change the legacy datastore configuration')
    require(json.loads((SETTINGS / 'read-only-verified.json').read_text())['transfer'] == request['transfer'], 'Read-only validation receipt mismatch')
    if read_only(node):
        path = repo(node) / 'config'; data = json.loads(path.read_text())
        for mount in data['Datastore']['Spec']['mounts']:
            if mount['mountpoint'] == '/blocks': mount['child']['readOnly'] = False
        write_private(path, data); host.ownership()
        host.run('systemctl', 'restart', 'ipfs'); host.wait_ready()
    initial = read_transfer(request['transfer'])
    journal = SETTINGS / 'initial-mfs.json'
    baseline = json.loads(journal.read_text())['baselineRoot'] if journal.exists() else host.rpc('files/stat', {'arg': '/', 'hash': 'true'})['Hash']
    replace_fenced_mfs(initial, host.rpc, router, journal, request['sha'], baseline)
    return {'writesEnabled': True, 'mfsVerified': True}


def nginx_workers():
    result = subprocess.run(['pgrep', '-f', '^nginx: worker process'], capture_output=True, text=True)
    return set(result.stdout.split())


def render_nginx(node, request):
    # Only validated numeric networks/IPs and an AWS-generated ALB DNS name enter
    # nginx syntax. Trust is tied to socket peers, not caller-supplied headers.
    dns = request['frontdoorDns']
    require(dns.endswith('.us-east-1.elb.amazonaws.com') and all(c.isalnum() or c in '.-' for c in dns), 'Invalid front door DNS')
    networks = [str(ipaddress.IPv4Network(cidr)) for cidr in CONTEXT['subnetCidrs']]
    peers = [str(ipaddress.IPv4Address(value)) for value in request['peerIps']]
    local = ['127.0.0.1/32', *networks, *[p + '/32' for p in peers]]
    config = '\n'.join('set_real_ip_from ' + p + ';' for p in local)
    config += '\nreal_ip_header X-Forwarded-For;\nreal_ip_recursive on;\n'
    config += 'geo $realip_remote_addr $ipfs_local { default 0; ' + ' '.join(p + ' 1;' for p in local) + ' }\n'
    config += 'geo $realip_remote_addr $ipfs_peer { default 0; ' + ' '.join(p + '/32 1;' for p in peers) + ' }\n'
    config += 'map "$ipfs_peer:$http_x_6529_ipfs_hop" $ipfs_hop { default ""; "1:1" "1"; }\n'
    config += 'map $ipfs_local $ipfs_rate_limit_key { default ""; 1 $binary_remote_addr; }\n'
    config += 'limit_req_zone $ipfs_rate_limit_key zone=ipfs_managed_add:10m rate=6r/m;\n'
    for name, port in [('api', 9080), ('gateway', 8080)]:
        config += 'map $ipfs_local $ipfs_' + name + '_upstream { 1 http://127.0.0.1:' + str(port) + '; 0 https://' + dns + '; }\n'
    # AWS VPC resolver resolves only the fixed ALB DNS for the cached-DNS bridge.
    config += 'resolver 169.254.169.253 valid=30s ipv6=off;\n'
    if is_legacy(node):
        config += 'include /etc/letsencrypt/options-ssl-nginx.conf;\nssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\n'
    else:
        config += 'ssl_session_tickets off;\n'
    site = (ROOT / 'templates/production-site.conf').read_text()
    for kind in ['API', 'GATEWAY']:
        certificate, key = certificate_paths(node, kind)
        site = site.replace('@' + kind + '_CERT@', certificate).replace('@' + kind + '_KEY@', key)
    return config, site


def certificate_paths(node, kind):
    if not is_legacy(node):
        return str(SETTINGS / 'tls/cert.pem'), str(SETTINGS / 'tls/key.pem')
    directory = '/etc/letsencrypt/live/' + ('api-ipfs.6529.io' if kind == 'API' else 'ipfs.6529.io')
    return directory + '/fullchain.pem', directory + '/privkey.pem'


def nginx_site(node, site, marker):
    if is_legacy(node):
        path = Path('/etc/nginx/sites-enabled/ipfs.6529.io.conf').resolve()
        require(marker.exists() or digest(path, NGINX_DIRECTORY) == CONTEXT['legacySiteSha256'] or
                path.read_text() == site, 'Legacy nginx differs from the reviewed baseline')
    else:
        path = Path('/etc/nginx/conf.d/6529-ipfs-site.conf')
    if marker.exists():
        previous = json.loads(marker.read_text())
        require(digest(path, NGINX_DIRECTORY) == previous['siteSha256'], 'Managed nginx site drifted')
    return path


def write_nginx_files(files):
    previous = {path: path.read_bytes() if path.exists() else None for path in files}
    for path, contents in files.items():
        path.write_text(contents)
    try:
        host.run('nginx', '-t')
    except ValueError:
        restore_nginx_files(previous)
        raise


def restore_nginx_files(previous):
    for path, contents in previous.items():
        if contents is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(contents)


def wait_nginx_workers(old_workers):
    # Pre-reload workers can hold uploads that bypass the router. Never kill
    # them and never take the final snapshot until they have all finished.
    for _ in range(3600):
        if not old_workers.intersection(nginx_workers()):
            return
        time.sleep(1)
    raise TimeoutError('Old nginx workers still serving accepted requests; do not hand over yet')


def configure_nginx(node, request):
    config, site = render_nginx(node, request)
    marker = SETTINGS / 'bridge.json'
    path = nginx_site(node, site, marker)
    old_workers = nginx_workers()
    if not is_legacy(node):
        Path('/etc/nginx/conf.d/default.conf').unlink(missing_ok=True)
        Path('/etc/nginx/nginx.conf').write_text('user nginx;\nworker_processes auto;\npid /run/nginx.pid;\nevents { worker_connections 4096; }\nhttp {\ninclude /etc/nginx/mime.types;\ndefault_type application/octet-stream;\nssl_protocols TLSv1.2 TLSv1.3;\ninclude /etc/nginx/conf.d/*.conf;\n}\n')
    write_nginx_files({path: site, Path('/etc/nginx/conf.d/00-6529-ipfs-routing.conf'): config})
    if not is_legacy(node):
        host.run('systemctl', 'unmask', 'nginx')
        host.run('systemctl', 'enable', '--now', 'nginx')
    host.run('systemctl', 'reload', 'nginx')
    wait_nginx_workers(old_workers)
    write_private(marker, {'frontdoorDns': request['frontdoorDns'], 'peerIps': request['peerIps'],
                          'directUploadsDrained': True, 'siteSha256': digest(path, NGINX_DIRECTORY)})
    return {'nginxVerified': True, 'directUploadsDrained': True}


def prepare_source(node, request):
    require((SETTINGS / 'backup-complete.json').exists(), 'Private recovery backup required before changing source nginx')
    router_service(node, request['sha'], True)
    return configure_nginx(node, request)


def status(node):
    result = {'instanceId': node, 'version': host.rpc('version')['Version'],
              'peerId': host.rpc('id')['ID'], 'mfsRoot': host.rpc('files/stat', {'arg': '/', 'hash': 'true'})['Hash'],
              'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'readOnly': read_only(node),
              'kernel': os.uname().release, 'rebootRequired': Path('/var/run/reboot-required').exists()}
    if (SETTINGS / ROUTER_STATE).exists(): result['router'] = router()
    cert = Path('/etc/letsencrypt/live/api-ipfs.6529.io/fullchain.pem') if is_legacy(node) else SETTINGS / 'tls/cert.pem'
    if cert.exists(): result['certificate'] = cert.read_text()
    return result


def sync(node, request):
    require(request['migrationId'] and all(c.isalnum() or c in '-_' for c in request['migrationId']), 'Invalid migration ID')
    require(not read_only(node), 'Final sync needs the validated writer role')
    saved = read_transfer(request['transfer'])
    count = merge_pins(saved, host.rpc)
    replace_fenced_mfs(saved, host.rpc, router, SETTINGS / ('sync-' + request['migrationId'] + JSON_SUFFIX),
                       request['migrationId'], request['baselineRoot'])
    return {'pinCount': count, 'mfsVerified': True, 'mfsRoot': saved['mfsRoot']}


def verify():
    # Retain the probe's pin so a later gateway/reboot check can read it.
    payload = ('6529 production IPFS ' + secrets.token_hex(24)).encode()
    boundary = '6529-ipfs-health'
    body = ('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="health.txt"\r\n\r\n').encode() + payload + ('\r\n--' + boundary + '--\r\n').encode()
    request = urllib.request.Request(host.API + 'add?pin=true', data=body, headers={'Content-Type': 'multipart/form-data; boundary=' + boundary})
    with urllib.request.urlopen(request, timeout=180) as response: cid = json.loads(response.read())['Hash']
    require(host.rpc('cat', {'arg': cid}, raw=True) == payload, 'Upload/read verification failed')
    require(cid in host.pin_inventory(), 'Verification upload was not pinned')
    def https(name, path, *extra):
        return host.run('curl', '--silent', '--show-error', '--fail', '--insecure', '--noproxy', '*',
                        '--resolve', name + ':443:127.0.0.1', *extra, 'https://' + name + path)
    require(json.loads(https('api-ipfs.6529.io', '/health'))['Version'] == host.rpc('version')['Version'], 'HTTPS health mismatch')
    require(https('ipfs-origin.6529.io', IPFS_PREFIX + cid) == payload, 'HTTPS gateway content mismatch')
    require(https('ipfs-origin.6529.io', IPFS_PREFIX + cid, '-H', 'Range: bytes=0-3') == payload[:4], 'Gateway byte range mismatch')
    forbidden = host.run('curl', '--silent', '--insecure', '--noproxy', '*', '--resolve', 'api-ipfs.6529.io:443:127.0.0.1',
                         '-X', 'POST', '-o', '/dev/null', '-w', '%{http_code}', 'https://api-ipfs.6529.io/api/v0/pin/ls')
    require(forbidden == b'403', 'Public administrative RPC must be forbidden')
    return {'uploadPinRead': True, 'httpsVerified': True, 'rangeVerified': True, 'restrictedRpc': True,
            'version': host.rpc('version')['Version'],
            'cid': cid, 'payloadBase64': base64.b64encode(payload).decode()}


def backup_operation(node, request):
    result = backup(node, request)
    write_private(SETTINGS / 'backup-complete.json', result)
    return result


def fence_operation(_node, request):
    result = set_router(request['mode'], request['mfsReady'], request.get('target'))
    if request['mode'] != 'forward':
        return result
    for _ in range(3600):
        result = router()
        if result['localActive'] == 0:
            return result
        time.sleep(1)
    raise TimeoutError('Accepted local uploads have not finished; keep forwarding and retry')


def snapshot_operation(node, request):
    current = router()
    require(current['mode'] == 'forward' and current['localActive'] == 0, 'Final snapshot requires a drained writer')
    return {'transfer': save_transfer(node, snapshot(host.rpc), request['label'])}


def reboot_operation(node, _request):
    current = router()
    require(not is_legacy(node) and current['mode'] == 'serve' and not current['mfsReady'], 'Reboot test only before production promotion')
    host.run('systemd-run', '--unit=6529-ipfs-reboot-check', '--on-active=5s', '/usr/sbin/reboot')
    return {'rebootScheduled': True, 'bootId': status(node)['bootId']}


def main(request):
    require(os.geteuid() == 0, 'Host operations require root')
    node = node_identity()
    require(node == request['instanceId'], 'EC2 identity mismatch')
    verify_release(request['sha'])
    identity = aws('sts', 'get-caller-identity', '--region', CONTEXT['region'])
    require(identity['Account'] == CONTEXT['accountId'] and identity['Arn'].endswith('/' + node), 'Host AWS calls must use its instance role')
    if not is_legacy(node):
        require(json.loads((SETTINGS / 'managed.json').read_text())['environment'] == 'prod', 'Unexpected runtime')
    actions = {'install': install, 'backup': backup_operation, 'status': lambda n, _: status(n),
               'restore-read-only': restore_read_only, 'enable-writes': enable_writes,
               'prepare-source': prepare_source, 'configure-nginx': configure_nginx,
               'fence': fence_operation, 'snapshot': snapshot_operation, 'sync': sync,
               'verify': lambda _node, _: verify(), 'reboot': reboot_operation}
    require(request['operation'] in actions, 'Unknown production operation')
    return actions[request['operation']](node, request)


if __name__ == '__main__':
    try:
        value = main(json.loads(base64.b64decode(sys.argv[1])))
        print(json.dumps({'protocol': '6529.ipfs.production.v1', 'result': value}))
    except Exception as error:
        # Private config, RPC payloads and subprocess output stay out of Actions.
        reason = str(error) if type(error) is ValueError else 'Inspect restricted host diagnostics'
        import traceback
        SETTINGS.mkdir(mode=0o700, parents=True, exist_ok=True)
        diagnostic = SETTINGS / 'production-failure.log'
        diagnostic.write_text(traceback.format_exc()); diagnostic.chmod(0o600)
        print(json.dumps({'protocol': '6529.ipfs.production.v1', 'failed': True, 'errorType': type(error).__name__, 'reason': reason}))
        sys.exit(1)
