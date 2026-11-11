"""Production IPFS replacement through plain CloudFormation and verified SSM.

The frozen adoption stack and shared CDN are never updated. Only the two named
DNS A records can move to the stable front door. Each operation is journalled in
versioned S3 before the controller waits for an external mutation to finish.
"""
import argparse
import base64
import hashlib
import ipaddress
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import yaml
from common import ROOT, aws, digest, environment_policy, matches, require, runtime_mutation_guard, source_identity_guard

CONTEXT = json.loads((ROOT / 'environments/production-deployment.json').read_text())
FRONTDOOR = 'seize-ipfs-prod-frontdoor'
RECEIPT = '6529.ipfs.production.v1'


def call(service, operation, *arguments):
    return aws(service, operation, '--region', CONTEXT['region'], *arguments, timeout=180)


def validate_id(value):
    require(matches(r'[a-z][a-z0-9-]{2,11}', value), 'Deployment ID must be 3-12 lowercase letters/digits/dashes')
    require(value != 'access', 'The access deployment ID is reserved for bootstrap authority')
    return value


def mutation_guard(sha):
    runtime_mutation_guard(sha, os.environ)
    account = call('sts', 'get-caller-identity')['Account']
    require(account == CONTEXT['accountId'], 'Unexpected AWS account')
    require(os.environ.get('IPFS_RUNTIME_SERVICE_ROLE_ARN') ==
            'arn:aws:iam::987989283142:role/seize-ipfs-prod-runtime-cloudformation', 'Unexpected CloudFormation role')


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def stack_exists(name):
    return any(s['StackName'] == name and s['StackStatus'] != 'DELETE_COMPLETE'
               for s in call('cloudformation', 'list-stacks')['StackSummaries'])


def stack(name):
    result = call('cloudformation', 'describe-stacks', '--stack-name', name)['Stacks']
    require(len(result) == 1 and result[0]['StackName'] == name, 'Unexpected stack identity')
    return result[0]


def outputs(value):
    return {item['OutputKey']: item['OutputValue'] for item in value.get('Outputs', [])}


def parameters(value):
    return {item['ParameterKey']: item['ParameterValue'] for item in value.get('Parameters', [])}


def wait_stack(name):
    for _ in range(360):
        value = stack(name)
        state = value['StackStatus']
        if state in ('CREATE_COMPLETE', 'UPDATE_COMPLETE'): return value
        require(state.endswith('_IN_PROGRESS') and 'ROLLBACK' not in state, 'CloudFormation failed; inspect stack events before retrying')
        time.sleep(5)
    raise TimeoutError('Stack is still running; reconcile the recorded operation before retrying')


def validate_changes(description, allowed, create):
    changes = description.get('Changes', [])
    require(changes, 'CloudFormation returned no resource changes')
    logical_ids = [entry['ResourceChange']['LogicalResourceId'] for entry in changes]
    require(len(logical_ids) == len(set(logical_ids)), 'Duplicate resource in change set')
    if create: require(set(logical_ids) == set(allowed), 'New stack resource set is incomplete')
    for entry in changes:
        resource = entry['ResourceChange']
        require(resource['LogicalResourceId'] in allowed, 'Unexpected resource in change set')
        if create:
            require(resource['Action'] == 'Add', 'New stack must only add resources')
        else:
            require(resource['Action'] == 'Modify' and resource.get('Replacement') == 'False',
                    'Updates must not remove or replace resources')


def normalize_template(value):
    return yaml.safe_load(value) if isinstance(value, str) else value


def validate_reference(value, prefix):
    require(isinstance(value, dict) and isinstance(value.get('key'), str) and value['key'].startswith(prefix)
            and '..' not in value['key'], 'Invalid versioned object reference')
    require(isinstance(value.get('version'), str) and value['version'] not in ('', 'null')
            and matches(r'[a-f0-9]{64}', value.get('sha256')), 'Missing object version or checksum')


def validate_receipt(request, value):
    require(isinstance(value, dict), 'Missing host operation result')
    operation = request['operation']
    if operation in ('status', 'install'):
        require(value.get('instanceId') == request['instanceId'] and isinstance(value.get('version'), str)
                and isinstance(value.get('mfsRoot'), str) and isinstance(value.get('bootId'), str)
                and type(value.get('readOnly')) is bool, 'Invalid host identity/status receipt')
    elif operation in ('backup', 'snapshot'):
        validate_reference(value.get('transfer'), 'prod/transfers/')
        if operation == 'backup':
            validate_reference(value.get('recovery'), 'prod/private/')
            require(value.get('privateIdentityBackedUp') is True, 'Private recovery archive was not verified')
    elif operation == 'fence':
        require(value.get('nodeId') == request['instanceId'] and value.get('mode') == request['mode']
                and value.get('mfsReady') is request['mfsReady'], 'Writer fence receipt mismatch')
        if request['mode'] == 'forward':
            require(value.get('targetNodeId') == request['target']['instanceId'] and type(value.get('localActive')) is int
                    and value['localActive'] == 0, 'Source still has accepted local uploads')
    else:
        checks = {'restore-read-only': ['readOnlyVerified'], 'enable-writes': ['writesEnabled', 'mfsVerified'],
                  'prepare-source': ['nginxVerified', 'directUploadsDrained'],
                  'configure-nginx': ['nginxVerified', 'directUploadsDrained'], 'sync': ['mfsVerified'],
                  'verify': ['uploadPinRead', 'httpsVerified', 'rangeVerified', 'restrictedRpc'], 'reboot': ['rebootScheduled']}
        require(operation in checks and all(value.get(key) is True for key in checks[operation]), 'Incomplete host verification receipt')
        if operation == 'verify':
            require(isinstance(value.get('cid'), str) and isinstance(value.get('payloadBase64'), str), 'Missing upload verification reference')
    return value


def parse_host_output(output, request):
    for line in reversed(output.splitlines()):
        try:
            envelope = json.loads(line)
        except ValueError:
            continue
        if isinstance(envelope, dict) and envelope.get('protocol') == RECEIPT:
            require(not envelope.get('failed'), 'Host operation failed')
            return validate_receipt(request, envelope.get('result'))
    raise ValueError('SSM success has no validated operation receipt')


class Controller:
    def __init__(self, args):
        self.args = args
        self.id = validate_id(args.deployment_id)
        self.sha = args.sha
        self.key = 'prod/deployments/' + self.id + '.json'
        self.path = Path(os.environ['RUNNER_TEMP']) / 'ipfs-production-journal.json'
        self.state = {'deploymentId': self.id, 'sourceSha': self.sha, 'versions': json.loads((ROOT / 'versions.json').read_text()), 'steps': {}}
        existing = call('s3api', 'list-object-versions', '--bucket', CONTEXT['backupsBucket'], '--prefix', self.key,
                        '--max-keys', '10')
        latest = [x for x in existing.get('Versions', []) if x['Key'] == self.key and x['IsLatest']]
        if latest:
            call('s3api', 'get-object', '--bucket', CONTEXT['backupsBucket'], '--key', self.key,
                 '--version-id', latest[0]['VersionId'], str(self.path))
            self.state = json.loads(self.path.read_text())
            require(args.operation != 'migrate' or self.state['sourceSha'] == self.sha, 'Deployment ID belongs to another release; use a new ID for new source')
        require(self.state['deploymentId'] == self.id and matches(r'[a-f0-9]{40}', self.state.get('sourceSha')), 'Deployment journal identity mismatch')
        require(not existing.get('DeleteMarkers'), 'Deployment journal was deleted; investigate rather than recreate')

    def save(self):
        self.path.write_text(json.dumps(self.state)); self.path.chmod(0o600)
        result = call('s3api', 'put-object', '--bucket', CONTEXT['backupsBucket'], '--key', self.key,
                      '--body', str(self.path), '--server-side-encryption', 'AES256')
        require(result.get('VersionId') not in (None, 'null'), 'Deployment journal must be versioned')

    def record(self, key, value):
        self.state[key] = value; self.save()
        return value

    def once(self, key, operation):
        if key not in self.state['steps']:
            self.state['steps'][key] = operation(); self.save()
        return self.state['steps'][key]

    def apply(self, name, template_name, desired, allowed):
        template = ROOT / 'cloudformation' / (template_name + '.yaml')
        document = yaml.safe_load(template.read_text())
        require(set(desired) == set(document['Parameters']), 'Every infrastructure parameter must be explicit')
        exists = stack_exists(name)
        revision = 'create'
        if exists:
            previous = stack(name)
            if previous['StackStatus'] == 'REVIEW_IN_PROGRESS':
                exists = False
            else:
                previous = wait_stack(name)
        if exists:
            deployed = call('cloudformation', 'get-template', '--stack-name', name)['TemplateBody']
            require(normalize_template(deployed) == document, 'Existing infrastructure template differs; review before updating')
            if parameters(previous) == desired:
                self.protect(name)
                return outputs(previous)
            revision = previous.get('LastUpdatedTime') or previous['CreationTime']
        # The same desired weights recur during rollback and final promotion.
        # Bind to the preceding stack revision so each transition gets a fresh
        # change set, while retries before execution reuse the recorded ARN.
        change_name = 'seize-ipfs-prod-' + fingerprint({'stack': name, 'sha': self.sha, 'revision': revision, 'parameters': desired})[:32]
        changes = self.state.setdefault('changeSets', {})
        key = name + '/' + change_name
        if key not in changes:
            values = [{'ParameterKey': k, 'ParameterValue': v} for k, v in desired.items()]
            result = call('cloudformation', 'create-change-set', '--stack-name', name, '--change-set-name', change_name,
                          '--change-set-type', 'UPDATE' if exists else 'CREATE', '--template-body', 'file://' + str(template),
                          '--parameters', json.dumps(values), '--capabilities', 'CAPABILITY_NAMED_IAM',
                          '--role-arn', os.environ['IPFS_RUNTIME_SERVICE_ROLE_ARN'], '--description', self.sha,
                          '--tags', 'Key=Service,Value=6529-ipfs', 'Key=Environment,Value=prod',
                          '--client-token', change_name)
            changes[key] = result['Id']; self.save()
        arn = changes[key]
        description = self.prepared_change(arn, name, desired, document, allowed)
        if description['ExecutionStatus'] == 'AVAILABLE':
            call('cloudformation', 'execute-change-set', '--change-set-name', arn, '--client-request-token', change_name)
        else:
            require(description['ExecutionStatus'] in ('EXECUTE_IN_PROGRESS', 'EXECUTE_COMPLETE'), 'Change set cannot be resumed')
        value = wait_stack(name)
        self.protect(name)
        return outputs(value)

    def prepared_change(self, arn, name, desired, document, allowed):
        for _ in range(120):
            description = call('cloudformation', 'describe-change-set', '--change-set-name', arn)
            require(description['StackName'] == name and description['Description'] == self.sha, 'Change set binding mismatch')
            if description['Status'] == 'CREATE_COMPLETE': break
            require(description['Status'] != 'FAILED', 'Change set failed; inspect AWS before retrying')
            time.sleep(2)
        else: raise TimeoutError('Change set still being prepared')
        # A CREATE-only operation is determined by the recorded change list, not
        # by a retry seeing its REVIEW_IN_PROGRESS placeholder as an existing stack.
        created = all(x['ResourceChange']['Action'] == 'Add' for x in description.get('Changes', []))
        permitted = set(document['Resources']) if created else set(allowed)
        validate_changes(description, permitted, created)
        actual_template = call('cloudformation', 'get-template', '--change-set-name', arn)['TemplateBody']
        require(normalize_template(actual_template) == document, 'Prepared template differs from reviewed YAML')
        require({x['ParameterKey']: x['ParameterValue'] for x in description['Parameters']} == desired, 'Prepared parameters changed')
        return description

    def protect(self, name):
        call('cloudformation', 'update-termination-protection', '--stack-name', name, '--enable-termination-protection')
        policy = {'Statement': [{'Effect': 'Allow', 'Action': 'Update:*', 'Principal': '*', 'Resource': '*'},
                                {'Effect': 'Deny', 'Action': ['Update:Replace', 'Update:Delete'], 'Principal': '*', 'Resource': '*'}]}
        call('cloudformation', 'set-stack-policy', '--stack-name', name, '--stack-policy-body', json.dumps(policy))

    def upload(self):
        bundle = Path(self.args.bundle).resolve()
        require(bundle == Path(os.environ['RUNNER_TEMP']).resolve() / 'ipfs-bundle.tar.gz', 'Unexpected release archive path')
        sha = digest(bundle, bundle.parent)
        key = 'prod/' + self.sha + '/bundle-' + sha + '.tar.gz'
        result = call('s3api', 'put-object', '--bucket', CONTEXT['artifactsBucket'], '--key', key, '--body', str(bundle),
                      '--server-side-encryption', 'AES256')
        require(result.get('VersionId') not in (None, 'null'), 'Artifact storage must be versioned')
        return {'key': key, 'version': result['VersionId'], 'sha256': sha}

    def node(self, instance_id):
        value = call('ec2', 'describe-instances', '--instance-ids', instance_id)['Reservations'][0]['Instances'][0]
        require(value['InstanceId'] == instance_id and value['VpcId'] == CONTEXT['vpcId'] and value['State']['Name'] == 'running', 'Unexpected or stopped instance')
        if instance_id == CONTEXT['legacyInstanceId']:
            require([g['GroupId'] for g in value['SecurityGroups']] == [CONTEXT['legacySecurityGroupId']] and
                    value.get('PublicIpAddress') == CONTEXT['legacyPublicIp'], 'Legacy network differs from the adopted baseline')
        else:
            tags = {x['Key']: x['Value'] for x in value.get('Tags', [])}
            require(tags.get('Service') == '6529-ipfs' and tags.get('Environment') == 'prod' and
                    tags.get('aws:cloudformation:stack-name', '').startswith('seize-ipfs-prod-runtime-') and
                    tags.get('aws:cloudformation:logical-id') == 'Instance', 'Unmanaged replacement')
        return {'instanceId': instance_id, 'privateIp': value['PrivateIpAddress'], 'publicIp': value.get('PublicIpAddress'),
                'securityGroupId': value['SecurityGroups'][0]['GroupId']}

    def host(self, node, operation, label=None, **values):
        artifact = self.state['artifact']
        validate_reference(artifact, 'prod/' + self.state['sourceSha'] + '/')
        release_sha = self.state['sourceSha']
        request = {'instanceId': node['instanceId'], 'sha': release_sha, 'operation': operation, **values}
        if label: request['label'] = label
        encoded = base64.b64encode(json.dumps(request).encode()).decode()
        release = '/opt/6529-ipfs/releases/' + release_sha
        # The trusted bootstrap validates every tar member before extraction and
        # binds both archive bytes and the manifest to this reviewed source.
        bootstrap = '''import hashlib,json,os,pathlib,subprocess,tarfile,tempfile
artifact=json.loads(%r); release=pathlib.Path(%r)
def checked(value):
 if not value: raise ValueError('Release archive verification failed')
if not release.exists():
 with tempfile.TemporaryDirectory() as temporary:
  path=pathlib.Path(temporary)/'bundle.tar.gz'
  subprocess.run(['aws','s3api','get-object','--region','us-east-1','--bucket',%r,'--key',artifact['key'],'--version-id',artifact['version'],str(path)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  checked(hashlib.sha256(path.read_bytes()).hexdigest()==artifact['sha256'])
  stage=pathlib.Path(temporary)/'release';stage.mkdir()
  with tarfile.open(path,'r:gz') as archive:
   members=archive.getmembers();checked(len(members)<1024 and sum(m.size for m in members)<600*1024*1024)
   checked(all((m.isfile() or m.isdir()) and not m.name.startswith('/') and (stage/m.name).resolve().is_relative_to(stage) for m in members))
   archive.extractall(stage,members=members,filter='data')
  manifest=json.loads((stage/'release.json').read_text());checked(manifest['sourceSha']==%r)
  checked(all((stage/name).resolve().is_relative_to(stage) and hashlib.sha256((stage/name).read_bytes()).hexdigest()==value for name,value in manifest['files'].items()))
  release.parent.mkdir(parents=True,exist_ok=True);os.rename(stage,release)
# The archive contains public code/binaries, never runtime config or keys.
# SSM's umask is 077 and tar's data filter leaves directory modes private;
# normalize this tree so the unprivileged ipfs service can execute its binary.
for directory in [release.parent.parent,release.parent,release]: directory.chmod(0o755)
for entry in release.rglob('*'):
 entry.chmod(0o755 if entry.is_dir() or entry in [release/'ipfs',release/'upload-router'] else 0o644)
os.execv('/usr/bin/python3',['python3',str(release/'production_host.py'),%r])
''' % (json.dumps(artifact), release, CONTEXT['artifactsBucket'], release_sha, encoded)
        script = 'set -eu\numask 077\nexport AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=false\nunset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE AWS_DEFAULT_PROFILE\ncloud-init status --wait >/dev/null\npython3 - <<\'IPFS_PRODUCTION\'\n' + bootstrap + '\nIPFS_PRODUCTION\n'
        token = fingerprint(request)
        commands = self.state.setdefault('commands', {})
        saved = commands.get(token)
        if saved:
            command_id = saved['id']
            prior = call('ssm', 'get-command-invocation', '--command-id', command_id, '--instance-id', node['instanceId'])
            if prior['Status'] in ('Failed', 'Cancelled', 'TimedOut'):
                # Failure is visible and preserves its command ID. A retry uses
                # the operation's durable host journal; never an automatic erase.
                print(json.dumps({'retryingFailedCommand': command_id, 'operation': operation}), flush=True)
                saved = None
        if not saved:
            result = call('ssm', 'send-command', '--instance-ids', node['instanceId'], '--document-name', 'AWS-RunShellScript',
                          '--parameters', json.dumps({'commands': [script], 'executionTimeout': ['7200']}),
                          '--comment', '6529 IPFS ' + self.id + ' ' + operation)
            command_id = result['Command']['CommandId']
            commands[token] = {'id': command_id, 'node': node['instanceId'], 'operation': operation}; self.save()
        print(json.dumps({'commandId': command_id, 'instanceId': node['instanceId'], 'operation': operation}), flush=True)
        return self.wait_host(command_id, node, request)

    def wait_host(self, command_id, node, request):
        for _ in range(1440):
            rows = call('ssm', 'list-command-invocations', '--command-id', command_id, '--details')['CommandInvocations']
            if not rows:
                time.sleep(5)
                continue
            result = rows[0]
            require(result['InstanceId'] == node['instanceId'], 'SSM command target mismatch')
            if result['Status'] == 'Success':
                # ListCommandInvocations truncates plugin output to 2,500 characters.
                # The full response API permits 24,000 and preserves the TLS
                # certificate/status receipt without weakening validation.
                full = call('ssm', 'get-command-invocation', '--command-id', command_id, '--instance-id', node['instanceId'])
                require(full['Status'] == 'Success', 'SSM result changed while fetching its full receipt')
                return parse_host_output(full['StandardOutputContent'], request)
            require(result['Status'] in ('Pending', 'InProgress', 'Delayed'), 'SSM failed; inspect the recorded command in restricted tooling')
            time.sleep(5)
        raise TimeoutError('SSM command is still running; resume its recorded command ID')

    def current_status(self, node):
        # Read operations must not reuse old receipts across reboots/fences.
        return self.host(node, 'status', nonce=str(time.time_ns()))

    def baseline(self):
        distribution = call('cloudfront', 'get-distribution-config', '--id', CONTEXT['distributionId'])['DistributionConfig']
        record = json.loads((ROOT / 'environments/adoption.json').read_text())
        require(fingerprint(distribution) == record['distributionConfigSha256'], 'Shared CDN differs from adoption baseline')
        return fingerprint(distribution)

    def dns(self, frontdoor):
        records = call('route53', 'list-resource-record-sets', '--hosted-zone-id', CONTEXT['hostedZoneId'])['ResourceRecordSets']
        changes = []
        for name in ['api-ipfs.6529.io', 'ipfs-origin.6529.io']:
            old = [r for r in records if r['Name'] == name + '.' and r['Type'] == 'A']
            require(len(old) == 1, 'Expected one canonical A record')
            desired = {'Name': name + '.', 'Type': 'A', 'AliasTarget': {'DNSName': 'dualstack.' + frontdoor['DnsName'] + '.',
                       'HostedZoneId': frontdoor['HostedZoneId'], 'EvaluateTargetHealth': False}}
            if old[0] == desired: continue
            require(old[0].get('ResourceRecords') == [{'Value': CONTEXT['legacyPublicIp']}], 'Canonical DNS differs from legacy or this front door')
            changes.append({'Action': 'UPSERT', 'ResourceRecordSet': desired})
        if not changes: return {'dnsVerified': True}
        result = call('route53', 'change-resource-record-sets', '--hosted-zone-id', CONTEXT['hostedZoneId'],
                      '--change-batch', json.dumps({'Changes': changes, 'Comment': 'Reviewed production IPFS front door'}))
        self.record('dnsChangeId', result['ChangeInfo']['Id'])
        for _ in range(120):
            if call('route53', 'get-change', '--id', result['ChangeInfo']['Id'])['ChangeInfo']['Status'] == 'INSYNC':
                return {'dnsVerified': True, 'changeId': result['ChangeInfo']['Id']}
            time.sleep(5)
        raise TimeoutError('DNS still propagating; keep the source bridge serving')

    def frontdoor(self, values):
        allowed = set()
        if stack_exists(FRONTDOOR):
            previous = parameters(wait_stack(FRONTDOOR))
            changed = {key for key in values if values[key] != previous[key]}
            require(changed.issubset({'ActiveSlot', 'SlotAInstanceId', 'SlotBInstanceId'}), 'Front door network/certificate changes require a separate review')
            if 'ActiveSlot' in changed:
                require(changed == {'ActiveSlot'}, 'Do not combine target registration with traffic switching')
                allowed.update(['ApiRule', 'GatewayRule', 'MediaGatewayRule', 'ValidationRule', 'ActiveWriterHealth'])
            for slot in ['a', 'b']:
                if 'Slot' + slot.upper() + 'InstanceId' in changed:
                    require(previous['ActiveSlot'] != slot, 'Never replace the currently serving target')
                    allowed.update(['Writer' + slot.upper(), 'Gateway' + slot.upper()])
        return self.apply(FRONTDOOR, 'frontdoor', values, allowed)


    def healthy(self, frontdoor):
        for _ in range(180):
            all_healthy = True
            for key in ['WriterAArn', 'WriterBArn', 'GatewayAArn', 'GatewayBArn']:
                states = call('elbv2', 'describe-target-health', '--target-group-arn', frontdoor[key])['TargetHealthDescriptions']
                all_healthy = all_healthy and len(states) == 1 and states[0]['TargetHealth']['State'] == 'healthy'
            if all_healthy: return {'allFourTargetGroupsHealthy': True}
            time.sleep(5)
        raise TimeoutError('Front door targets are not healthy; traffic stays on the current writer')

    def check_public(self, probe, frontdoor=None):
        payload = base64.b64decode(probe['payloadBase64'])
        name = 'ipfs-runtime-check.6529.io' if frontdoor else 'api-ipfs.6529.io'
        connect = ['--connect-to', name + ':443:' + frontdoor['DnsName'] + ':443'] if frontdoor else []
        def curl(path, extra=None):
            result = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--noproxy', '*', '--max-time', '180',
                                     *connect, *(extra or []), 'https://' + name + path], capture_output=True)
            require(result.returncode == 0, 'Public HTTPS validation failed')
            return result.stdout
        # Exercise the public synchronous upload route, including nginx limits
        # and ALB forwarding. Every probe is pinned and included in later unions.
        public_payload = payload + b' public path'
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'probe.txt'; path.write_bytes(public_payload)
            response = curl('/api/v0/add?pin=true', ['-F', 'file=@' + str(path)])
        uploaded = json.loads(response.splitlines()[-1])['Hash']
        require(json.loads(curl('/health'))['Version'] == probe.get('version', self.state['versions']['kuboVersion']), 'Public runtime version mismatch')
        if frontdoor:
            require(curl('/ipfs/' + uploaded) == public_payload, 'Inactive target cannot read the verified upload')
        else:
            for gateway in ['ipfs-origin.6529.io', 'ipfs.6529.io', 'ipfs-cache.6529.io']:
                result = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--noproxy', '*', '--max-time', '180',
                                         'https://' + gateway + '/ipfs/' + uploaded], capture_output=True)
                require(result.returncode == 0 and result.stdout == public_payload, 'Production gateway/CDN upload verification failed')
        return {'publicHttpsVerified': True, 'cid': uploaded}

    def promote(self, source, target, target_slot, label):
        migration = self.id + '-' + label
        current_frontdoor = parameters(wait_stack(FRONTDOOR))
        require(current_frontdoor['Slot' + target_slot.upper() + 'InstanceId'] == target['instanceId'], 'Target slot identity mismatch')
        self.state['frontdoorParameters'] = current_frontdoor
        if current_frontdoor['ActiveSlot'] == target_slot:
            # A retry after the listener switch, or a repeated rollback request,
            # must never overwrite the active writer with its stale predecessor.
            current = self.current_status(target)
            require(current['router']['mode'] == 'serve' and current['router']['mfsReady'], 'Active writer is not ready; reconcile before proceeding')
            probe = self.host(target, 'verify', nonce=str(time.time_ns()))
            self.check_public(probe); self.baseline()
            return {'activeInstanceId': target['instanceId'], 'activeSlot': target_slot, 'alreadyActive': True, 'probeCid': probe['cid']}
        require(current_frontdoor['Slot' + current_frontdoor['ActiveSlot'].upper() + 'InstanceId'] == source['instanceId'],
                'The source is no longer the active writer; another deployment superseded this handover')
        phase = self.state.setdefault('handovers', {}).get(label)
        if not phase:
            current = self.current_status(target)
            require(current['router']['nodeId'] == target['instanceId'], 'Wrong target router')
            self.host(target, 'fence', mode='serve', mfsReady=False, handoverId=migration)
            current = self.current_status(target)
            phase = {'baselineRoot': current['mfsRoot'], 'migrationId': migration, 'target': target['instanceId']}
            self.state['handovers'][label] = phase; self.save()
        require(phase['target'] == target['instanceId'], 'Handover target changed')
        target_status = self.current_status(target)
        peer = {**target, 'certificate': target_status['certificate']}
        self.once(label + '-source-fenced', lambda: self.host(source, 'fence', mode='forward', mfsReady=True, target=peer, handoverId=migration))
        final = self.once(label + '-final-snapshot', lambda: self.host(source, 'snapshot', label=migration))
        self.once(label + '-state-synced', lambda: self.host(target, 'sync', transfer=final['transfer'],
                  migrationId=migration, baselineRoot=phase['baselineRoot']))
        self.once(label + '-mutable-ready', lambda: self.host(target, 'fence', mode='serve', mfsReady=True, handoverId=migration))
        values = dict(self.state['frontdoorParameters']); values['ActiveSlot'] = target_slot
        self.once(label + '-traffic-switched', lambda: self.frontdoor(values))
        self.record('frontdoorParameters', values)
        probe = self.once(label + '-probe', lambda: self.host(target, 'verify', handoverId=migration))
        self.once(label + '-public-verified', lambda: self.check_public(probe))
        self.baseline()
        return {'activeInstanceId': target['instanceId'], 'activeSlot': target_slot, 'transfer': final['transfer'], 'probeCid': probe['cid']}

    def migrate(self):
        if self.state.get('completed'):
            return {**self.verify_current(), 'alreadyCompleted': True}
        self.once('cdn-baseline', self.baseline)
        self.once('source-discovery', self.discover_source)
        
        if 'source' not in self.state:
            self.state.update(self.state['steps']['source-discovery']); self.save()
        source = self.state['source']
        self.once('artifact', self.upload)
        self.state['artifact'] = self.state['steps']['artifact']; self.save()
        self.once('source-writer-ready', lambda: self.source_ready(source))
        initial = self.once('initial-backup', lambda: self.host(source, 'backup', label=self.id + '-initial'))
        frontdoor = self.once('frontdoor-created', lambda: self.frontdoor(self.state['frontdoorParameters']))
        runtime_name = 'seize-ipfs-prod-runtime-' + self.id
        runtime_parameters = {'VpcId': CONTEXT['vpcId'], 'SubnetId': CONTEXT['subnetIds'][0], 'ImageId': CONTEXT['imageId'],
                              'InstanceType': 't3.large', 'FrontdoorSecurityGroup': frontdoor['SecurityGroupId'],
                              'SourceSecurityGroup': source['securityGroupId'], 'RuntimeBoundaryArn': CONTEXT['runtimeBoundaryArn'],
                              'AllowWrites': 'false', 'PublishSwarm': 'false'}
        runtime = self.once('runtime-created', lambda: self.apply(runtime_name, 'runtime', runtime_parameters, []))
        target = self.once('target-discovery', lambda: self.node(runtime['InstanceId']))
        self.record('target', target)
        peers = [n[k] for n in [source, target] for k in ['privateIp', 'publicIp'] if n.get(k)]
        routing = {'frontdoorDns': frontdoor['DnsName'], 'peerIps': peers}
        self.once('target-installed', lambda: self.host(target, 'install', transfer=initial['transfer'], **routing))
        self.once('read-only-restore', lambda: self.host(target, 'restore-read-only', transfer=initial['transfer']))
        write_parameters = {**runtime_parameters, 'AllowWrites': 'true'}
        self.once('write-role-enabled', lambda: self.apply(runtime_name, 'runtime', write_parameters, ['Role']))
        self.once('target-write-enabled', lambda: self.host(target, 'enable-writes', transfer=initial['transfer']))
        probe = self.once('target-verified', lambda: self.host(target, 'verify'))
        self.once('reboot-requested', lambda: self.host(target, 'reboot'))
        self.once('reboot-verified', lambda: self.verify_reboot(target, probe))
        self.once('swarm-published', lambda: self.apply(runtime_name, 'runtime', {**write_parameters, 'PublishSwarm': 'true'}, ['SecurityGroup']))
        self.once('public-swarm', lambda: self.verify_swarm(target))
        self.once('source-bridge', lambda: self.host(source, 'prepare-source', **routing))
        values = dict(self.state['frontdoorParameters'])
        values['Slot' + self.state['targetSlot'].upper() + 'InstanceId'] = target['instanceId']
        frontdoor = self.once('target-registered', lambda: self.frontdoor(values))
        self.record('frontdoorParameters', values)
        self.once('target-health', lambda: self.healthy(frontdoor))
        self.once('inactive-https', lambda: self.check_public(probe, frontdoor))
        self.once('canonical-dns', lambda: self.dns(frontdoor))
        self.once('first-promotion', lambda: self.promote(source, target, self.state['targetSlot'], 'promote'))
        # A real reverse handover proves that writes accepted on the replacement
        # survive rollback. Both hosts and all data remain retained throughout.
        self.once('rollback-backup', lambda: self.host(target, 'backup', label=self.id + '-rollback'))
        self.once('rollback-rehearsal', lambda: self.promote(target, source, self.state['sourceSlot'], 'rollback'))
        result = self.once('final-promotion', lambda: self.promote(source, target, self.state['targetSlot'], 'final'))
        self.verify_alarms([frontdoor['HealthAlarm'], runtime['HealthAlarm']])
        self.record('completed', result)
        return result

    def source_ready(self, node):
        current = self.current_status(node)
        state = current.get('router')
        if state:
            require(state['mode'] == 'serve' and state['mfsReady'],
                    'Unfinished writer handover: resume its original deployment instead of starting another')
        else:
            require(node['instanceId'] == CONTEXT['legacyInstanceId'], 'Managed source is missing its writer router')
        return {'sourceWriterReady': True, 'instanceId': node['instanceId']}

    def verify_current(self):
        current = parameters(wait_stack(FRONTDOOR))
        instance_id = current['Slot' + current['ActiveSlot'].upper() + 'InstanceId']
        require(instance_id in {self.state['source']['instanceId'], self.state['target']['instanceId']},
                'Another deployment superseded this one; use its deployment ID')
        node = self.node(instance_id)
        probe = self.host(node, 'verify', nonce=str(time.time_ns()))
        self.check_public(probe); self.baseline()
        return {'activeInstanceId': instance_id, 'activeSlot': current['ActiveSlot'], 'verified': True}

    def verify_alarms(self, names):
        for _ in range(120):
            rows = call('cloudwatch', 'describe-alarms', '--alarm-names', *names)['MetricAlarms']
            if len(rows) == len(names) and all(row['StateValue'] == 'OK' for row in rows):
                return self.record('alarmsVerified', {'alarmNames': names, 'state': 'OK'})
            time.sleep(5)
        raise TimeoutError('Runtime alarms have not become healthy; inspect before completing deployment')

    def verify_swarm(self, node):
        address = str(ipaddress.IPv4Address(node['publicIp']))
        require(ipaddress.ip_address(address).is_global, 'Expected the managed runtime public address')
        with socket.create_connection((address, 4001), timeout=15):
            return {'publicSwarmTcpReachable': True, 'instanceId': node['instanceId']}

    def discover_source(self):
        if stack_exists(FRONTDOOR):
            current = wait_stack(FRONTDOOR); values = parameters(current)
            source_slot = values['ActiveSlot']; target_slot = 'b' if source_slot == 'a' else 'a'
            source = self.node(values['Slot' + source_slot.upper() + 'InstanceId'])
        else:
            source_slot, target_slot = 'a', 'b'
            source = self.node(CONTEXT['legacyInstanceId'])
            values = {'VpcId': CONTEXT['vpcId'], 'SubnetIds': ','.join(CONTEXT['subnetIds']),
                      'CertificateArn': CONTEXT['certificateArn'], 'SlotAInstanceId': source['instanceId'],
                      'SlotBInstanceId': '', 'ActiveSlot': source_slot}
        return {'source': source, 'sourceSlot': source_slot, 'targetSlot': target_slot, 'frontdoorParameters': values}

    def verify_reboot(self, target, probe):
        old_boot = self.state['steps']['reboot-requested']['bootId']
        for _ in range(180):
            info = call('ssm', 'describe-instance-information', '--filters',
                        json.dumps([{'Key': 'InstanceIds', 'Values': [target['instanceId']]}]))['InstanceInformationList']
            if info and info[0]['PingStatus'] == 'Online':
                try:
                    current = self.current_status(target)
                    if current['bootId'] != old_boot:
                        require(current['router']['mode'] == 'serve' and not current['router']['mfsReady'], 'Writer fence did not survive reboot')
                        require(current.get('rebootRequired') is False, 'Installed OS security updates still require a reboot')
                        require(current['version'] == self.state['versions']['kuboVersion'], 'Wrong rebooted version')
                        self.host(target, 'verify', rebootCheck=True)
                        return {'rebootPersistenceVerified': True, 'bootId': current['bootId'], 'probeCid': probe['cid']}
                except ValueError:
                    # Reboot may race the first status command; it is read-only.
                    pass
            time.sleep(5)
        raise TimeoutError('Replacement reboot verification did not complete')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['plan', 'migrate', 'verify', 'rollback', 'promote', 'backup'])
    parser.add_argument('--sha', required=True)
    parser.add_argument('--deployment-id', required=True)
    parser.add_argument('--bundle', default='')
    args = parser.parse_args()
    validate_id(args.deployment_id); source_identity_guard(args.sha, os.environ)
    if args.operation == 'plan':
        print(json.dumps({'deploymentId': args.deployment_id, 'sourceSha': args.sha, 'environment': 'prod',
              'templates': ['frontdoor.yaml', 'runtime.yaml', 'recovery.yaml', 'runtime-access.yaml'],
              'changesEnabled': environment_policy('prod')['changesEnabled'], 'separateStagingEnvironment': False}))
        return
    mutation_guard(args.sha)
    controller = Controller(args)
    if args.operation == 'migrate': result = controller.migrate()
    else:
        require(controller.state.get('completed'), 'An existing completed deployment is required')
        source, target = controller.state['source'], controller.state['target']
        if args.operation == 'rollback': result = controller.promote(target, source, controller.state['sourceSlot'], 'manual-rollback-' + os.environ['GITHUB_RUN_ID'])
        elif args.operation == 'promote': result = controller.promote(source, target, controller.state['targetSlot'], 'manual-promote-' + os.environ['GITHUB_RUN_ID'])
        elif args.operation == 'backup':
            active = parameters(stack(FRONTDOOR))['ActiveSlot']
            node = target if active == controller.state['targetSlot'] else source
            result = controller.host(node, 'backup', label=controller.id + '-manual-' + str(int(time.time())))
        else:
            result = controller.verify_current()
    print(json.dumps({'protocol': RECEIPT, 'operation': args.operation, 'result': result}))


if __name__ == '__main__':
    main()
