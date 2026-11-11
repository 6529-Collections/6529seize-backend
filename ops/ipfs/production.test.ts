import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

function python(body: string) {
  return execFileSync(
    'python3',
    [
      '-c',
      `import sys,json,os,copy\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nimport production as p\n${body}`,
      __dirname
    ],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
  ).trim();
}

const rejected = `
def rejected(operation):
 try: operation()
 except ValueError: return
 raise AssertionError('Unsafe operation accepted')
`;

describe('production IPFS deployment controls', () => {
  test('rejects disabled changes, enabled import and mismatched source before AWS authentication', () => {
    expect(
      python(`${rejected}
import common
sha='a'*40
env={'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':'6529-Collections/6529seize-backend','GITHUB_REF':'refs/heads/main','GITHUB_SHA':sha}
os.environ.update(env)
p.call=lambda *a,**k:(_ for _ in ()).throw(AssertionError('AWS called before guard'))
for policy in [{'changesEnabled':False,'adoptionEnabled':False},{'changesEnabled':True,'adoptionEnabled':True}]:
 common.environment_policy=lambda _,policy=policy:policy
 rejected(lambda:p.mutation_guard(sha))
common.environment_policy=lambda _:{'changesEnabled':True,'adoptionEnabled':False}
os.environ['GITHUB_REF']='refs/heads/1a-staging'
rejected(lambda:p.mutation_guard(sha))
print('closed')
`)
    ).toBe('closed');
  });

  test('refuses removal, replacement, unrelated changes and incomplete creates', () => {
    expect(
      python(`${rejected}
def change(action='Modify',logical='Role',replacement='False'):
 return {'Changes':[{'ResourceChange':{'Action':action,'LogicalResourceId':logical,'Replacement':replacement}}]}
for value in [change('Remove'),change(replacement='True'),change(replacement='Conditional'),change(logical='Instance')]:
 rejected(lambda value=value:p.validate_changes(value,{'Role'},False))
rejected(lambda:p.validate_changes(change('Add'),{'Role','Instance'},True))
rejected(lambda:p.validate_changes({'Changes':change()['Changes']*2},{'Role'},False))
p.validate_changes(change(),{'Role'},False)
print('bounded')
`)
    ).toBe('bounded');
  });

  test('requires verified restoration and a drained writer even when SSM says Success', () => {
    expect(
      python(`${rejected}
for operation in ['restore-read-only','enable-writes','prepare-source','sync','verify']:
 rejected(lambda operation=operation:p.validate_receipt({'operation':operation},{}))
r={'operation':'fence','instanceId':'old','mode':'forward','mfsReady':True,'target':{'instanceId':'new'}}
value={'nodeId':'old','targetNodeId':'new','mode':'forward','mfsReady':True,'localActive':1}
rejected(lambda:p.validate_receipt(r,value))
value['localActive']=0
p.validate_receipt(r,value)
rejected(lambda:p.validate_reference({'key':'prod/transfers/backup.json','version':'null','sha256':'a'*64},'prod/transfers/'))
print('verified')
`)
    ).toBe('verified');
  });

  test('never replaces a serving slot or combines registration with a traffic switch', () => {
    expect(
      python(`${rejected}
values={'ActiveSlot':'a','SlotAInstanceId':'old','SlotBInstanceId':'new','VpcId':'vpc'}
p.stack_exists=lambda _:True
p.wait_stack=lambda _:{'Parameters':[{'ParameterKey':k,'ParameterValue':v} for k,v in values.items()]}
c=object.__new__(p.Controller)
c.apply=lambda *args:sorted(args[-1])
rejected(lambda:c.frontdoor({**values,'SlotAInstanceId':'replacement'}))
rejected(lambda:c.frontdoor({**values,'SlotBInstanceId':'replacement','ActiveSlot':'b'}))
rejected(lambda:c.frontdoor({**values,'VpcId':'other'}))
assert c.frontdoor({**values,'SlotBInstanceId':'replacement'})==['GatewayB','WriterB']
assert c.frontdoor({**values,'ActiveSlot':'b'})==['ActiveWriterHealth','ApiRule','GatewayRule','MediaGatewayRule','ValidationRule']
print('isolated')
`)
    ).toBe('isolated');
  });

  test('a repeated rollback never copies stale state over the already active writer', () => {
    expect(
      python(`
p.wait_stack=lambda _:{'Parameters':[{'ParameterKey':k,'ParameterValue':v} for k,v in {'ActiveSlot':'a','SlotAInstanceId':'old','SlotBInstanceId':'new'}.items()]}
c=object.__new__(p.Controller);c.id='release';c.state={}
c.current_status=lambda _: {'router':{'mode':'serve','mfsReady':True}}
operations=[]
c.host=lambda node,operation,**kwargs:operations.append(operation) or {'cid':'health'}
c.check_public=lambda _:None;c.baseline=lambda:None
result=c.promote({'instanceId':'new'},{'instanceId':'old'},'a','rollback-retry')
assert result['alreadyActive'] and operations==['verify']
print('preserved')
`)
    ).toBe('preserved');
  });

  test('the handover fences, drains, snapshots and syncs before opening mutable writes and switching traffic', () => {
    expect(
      python(`
values={'ActiveSlot':'a','SlotAInstanceId':'old','SlotBInstanceId':'new'}
p.wait_stack=lambda _:{'Parameters':[{'ParameterKey':k,'ParameterValue':v} for k,v in values.items()]}
c=object.__new__(p.Controller);c.id='release';c.state={'steps':{}};c.save=lambda:None
operations=[]
c.current_status=lambda _: {'mfsRoot':'baseline','certificate':'certificate','router':{'nodeId':'new'}}
def host(node,operation,**kwargs):
 operations.append((node['instanceId'],operation,kwargs))
 if operation=='snapshot':return {'transfer':{'key':'final'}}
 if operation=='verify':return {'cid':'health'}
 return {}
c.host=host
c.frontdoor=lambda _:operations.append(('alb','switch',{})) or {}
c.check_public=lambda _:operations.append(('public','verify',{}))
c.baseline=lambda:None
c.promote({'instanceId':'old'},{'instanceId':'new'},'b','first')
assert [(n,o) for n,o,_ in operations]==[('new','fence'),('old','fence'),('old','snapshot'),('new','sync'),('new','fence'),('alb','switch'),('new','verify'),('public','verify')]
assert operations[0][2]['mfsReady'] is False and operations[4][2]['mfsReady'] is True
assert operations[0][2]['handoverId']=='release-first'
assert operations[3][2]['baselineRoot']=='baseline'
assert operations[6][2]['handoverId']=='release-first'
print('ordered')
`)
    ).toBe('ordered');
  });

  test('renders a cached DNS bridge from trusted socket peers and rejects nginx syntax injection', () => {
    expect(
      python(`${rejected}
import production_host as h
request={'frontdoorDns':'seize-ipfs-prod-test.us-east-1.elb.amazonaws.com','peerIps':['172.31.30.106','18.232.173.145']}
http,site=h.render_nginx(h.CONTEXT['legacyInstanceId'],request)
assert 'geo $realip_remote_addr $ipfs_local' in http
assert 'proxy_set_header X-Forwarded-For $remote_addr;' in site
assert 'proxy_set_header X-6529-IPFS-Hop $ipfs_hop;' in site
assert 'proxy_ssl_verify on;' in site and 'client_max_body_size 50m;' in site
assert 'proxy_pass $ipfs_api_upstream;' in site and 'proxy_set_header Host ipfs-origin.6529.io;' in site
rejected(lambda:h.render_nginx('candidate',{**request,'frontdoorDns':'x;include /etc/passwd;.us-east-1.elb.amazonaws.com'}))
print('trusted')
`)
    ).toBe('trusted');
  });

  test('uses a new change set when identical desired weights recur after rollback', () => {
    expect(
      python(`
os.environ['IPFS_RUNTIME_SERVICE_ROLE_ARN']='arn:aws:iam::987989283142:role/seize-ipfs-prod-runtime-cloudformation'
c=object.__new__(p.Controller);c.sha='a'*40;c.state={};c.save=lambda:None;c.protect=lambda _:None
p.stack_exists=lambda _:True
values={'VpcId':'vpc','SubnetIds':'a,b','CertificateArn':'cert','SlotAInstanceId':'old','SlotBInstanceId':'new','ActiveSlot':'a'}
document=p.yaml.safe_load((p.ROOT/'cloudformation/frontdoor.yaml').read_text())
revision=0;names=[];executed=[];plans={}
def current(_):
 return {'StackStatus':'UPDATE_COMPLETE','Parameters':[{'ParameterKey':k,'ParameterValue':v} for k,v in values.items()], 'LastUpdatedTime':str(revision),'CreationTime':'initial','Outputs':[]}
p.stack=current;p.wait_stack=current
def call(service,operation,*args):
 global revision,values
 if operation=='get-template':return {'TemplateBody':document}
 if operation=='create-change-set':
  name=args[args.index('--change-set-name')+1];names.append(name)
  desired=json.loads(args[args.index('--parameters')+1])
  plans[name]=desired
  return {'Id':name}
 if operation=='describe-change-set':
  name=args[args.index('--change-set-name')+1]
  return {'StackName':p.FRONTDOOR,'Description':c.sha,'Status':'CREATE_COMPLETE','ExecutionStatus':'AVAILABLE' if name not in executed else 'EXECUTE_COMPLETE',
   'Parameters':plans[name],'Changes':[{'ResourceChange':{'LogicalResourceId':'ApiRule','Action':'Modify','Replacement':'False'}}]}
 if operation=='execute-change-set':
  name=args[args.index('--change-set-name')+1];executed.append(name)
  values={x['ParameterKey']:x['ParameterValue'] for x in plans[name]};revision+=1;return {}
 raise AssertionError(operation)
p.call=call
for active in ['b','a','b']:
 c.apply(p.FRONTDOOR,'frontdoor',{**values,'ActiveSlot':active},['ApiRule'])
assert len(executed)==3 and len(set(names))==3 and values['ActiveSlot']=='b'
print('three real transitions')
`)
    ).toBe('three real transitions');
  });

  test('refuses a new migration while the current source is forwarding an unfinished handover', () => {
    expect(
      python(`${rejected}
c=object.__new__(p.Controller)
node={'instanceId':'managed'}
for state in [{'mode':'forward','mfsReady':True},{'mode':'serve','mfsReady':False}]:
 c.current_status=lambda _,state=state:{'router':state}
 rejected(lambda:c.source_ready(node))
c.current_status=lambda _:{'router':{'mode':'serve','mfsReady':True}}
assert c.source_ready(node)['sourceWriterReady']
rejected(lambda:p.validate_id('access'))
print('resume required')
`)
    ).toBe('resume required');
  });

  test('separates runtime stack authority from the similarly named bootstrap stack', () => {
    const template = parse(
      readFileSync(
        join(__dirname, 'cloudformation/runtime-access.yaml'),
        'utf8'
      )
    );
    const statements =
      template.Resources.DeploymentRole.Properties.Policies[0].PolicyDocument
        .Statement;
    expect(statements).toContainEqual(
      expect.objectContaining({
        Effect: 'Deny',
        Action: expect.arrayContaining([
          'cloudformation:ExecuteChangeSet',
          'cloudformation:SetStackPolicy'
        ]),
        Resource:
          'arn:aws:cloudformation:us-east-1:987989283142:stack/seize-ipfs-prod-runtime-access/*'
      })
    );
  });

  test('validates rollback against the verified previous version instead of requiring the replacement version', () => {
    expect(
      python(`
from types import SimpleNamespace
import base64
c=object.__new__(p.Controller);c.state={'versions':{'kuboVersion':'new-version'}}
probe={'version':'previous-version','payloadBase64':base64.b64encode(b'probe').decode(),'cid':'local-probe'}
def run(arguments,**kwargs):
 url=arguments[-1]
 if '/api/v0/add' in url:return SimpleNamespace(returncode=0,stdout=b'{"Hash":"public-probe"}')
 if url.endswith('/health'):return SimpleNamespace(returncode=0,stdout=b'{"Version":"previous-version"}')
 return SimpleNamespace(returncode=0,stdout=b'probe public path')
p.subprocess.run=run
assert c.check_public(probe)['publicHttpsVerified']
print('previous version verified')
`)
    ).toBe('previous version verified');
  });

  test('replaying a completed migration verifies the real current writer without replaying old handovers', () => {
    expect(
      python(`
c=object.__new__(p.Controller);c.state={'completed':{'activeSlot':'b'}}
c.verify_current=lambda:{'activeSlot':'a','activeInstanceId':'old','verified':True}
result=c.migrate()
assert result['alreadyCompleted'] and result['activeSlot']=='a'
print('actual writer reported')
`)
    ).toBe('actual writer reported');
  });

  test('reads the full SSM result when the list response truncates a certificate receipt', () => {
    expect(
      python(`
c=object.__new__(p.Controller)
node={'instanceId':'i-source'}
request={'instanceId':'i-source','operation':'status'}
value={'instanceId':'i-source','version':'0.43.1','mfsRoot':'root','bootId':'boot','readOnly':False,'certificate':'certificate-data'*500}
output=json.dumps({'protocol':p.RECEIPT,'result':value})
assert len(output)>2500
calls=[]
def call(service,operation,*args):
 calls.append(operation)
 if operation=='list-command-invocations':return {'CommandInvocations':[{'InstanceId':'i-source','Status':'Success','CommandPlugins':[{'Output':output[:2500]}]}]}
 if operation=='get-command-invocation':return {'Status':'Success','StandardOutputContent':output}
 raise AssertionError(operation)
p.call=call
assert c.wait_host('command',node,request)['certificate']==value['certificate']
assert calls==['list-command-invocations','get-command-invocation']
print('complete receipt')
`)
    ).toBe('complete receipt');
  });

  test('waits for the replacement itself to be online in Systems Manager', () => {
    expect(
      python(`
responses=iter([[],[{'InstanceId':'other','PingStatus':'Online'}],[{'InstanceId':'new','PingStatus':'ConnectionLost'}],[{'InstanceId':'new','PingStatus':'Online'}]])
def call(service,operation,option,filters):
 assert (service,operation,option)==('ssm','describe-instance-information','--filters')
 assert json.loads(filters)==[{'Key':'InstanceIds','Values':['new']}]
 return {'InstanceInformationList':next(responses)}
waits=[];p.call=call;p.time.sleep=waits.append
p.wait_ssm_online('new')
assert waits==[5,5,5]
print('candidate registered')
`)
    ).toBe('candidate registered');
  });

  test('keeps public peering closed while installing OS security updates and until reboot validation', () => {
    const template = parse(
      readFileSync(join(__dirname, 'cloudformation/runtime.yaml'), 'utf8')
    );
    expect(template.Parameters.PublishSwarm.Default).toBe('false');
    expect(
      template.Resources.Instance.Properties.UserData['Fn::Base64']
    ).toContain('full-upgrade -y');
    const ingress =
      template.Resources.SecurityGroup.Properties.SecurityGroupIngress;
    expect(ingress).toContainEqual({
      'Fn::If': [
        'SwarmPublished',
        {
          IpProtocol: 'tcp',
          FromPort: 4001,
          ToPort: 4001,
          CidrIp: '0.0.0.0/0'
        },
        { Ref: 'AWS::NoValue' }
      ]
    });
  });

  test('validates both private peer paths and retains write access before publishing peering or switching traffic', () => {
    expect(
      python(`
c=object.__new__(p.Controller);c.id='release';c.sha='a'*40;c.state={'steps':{}};c.save=lambda:None
events=[];updates=[]
source={'instanceId':'old','securityGroupId':'source-group','privateIp':'172.31.20.1','publicIp':'18.1.1.1'}
target={'instanceId':'new','securityGroupId':'target-group','privateIp':'172.31.20.2','publicIp':'18.1.1.2'}
c.baseline=lambda:{}
c.discover_source=lambda:{'source':source,'sourceSlot':'a','targetSlot':'b','frontdoorParameters':{}}
c.upload=lambda:{};c.source_ready=lambda _:{}
door={'SecurityGroupId':'frontdoor-group','RuntimePeerGroupId':'private-peers','DnsName':'alb','HealthAlarm':'alb-alarm'}
c.frontdoor=lambda _:door;c.node=lambda _:target
def apply(name,template,values,allowed):
 updates.append((dict(values),allowed));return {'InstanceId':'new','HealthAlarm':'instance-alarm'}
c.apply=apply
def host(node,operation,**values):
 events.append((operation,node['instanceId'],values))
 return {'transfer':{},'cid':'probe'}
c.host=host;c.current_status=lambda _:{'certificate':'public-certificate'}
c.verify_reboot=lambda *args:events.append(('reboot-verified',None,{}))
c.verify_swarm=lambda *args:events.append(('swarm',None,{}))
c.healthy=lambda _:{};c.check_public=lambda *args:{}
c.dns=lambda _:events.append(('dns',None,{}))
c.promote=lambda *args:events.append(('promote',None,{})) or {}
c.verify_alarms=lambda _:None
c.migrate()
assert [(v['AllowWrites'],v['PublishSwarm']) for v,_ in updates]==[('false','false'),('true','false'),('true','true')]
assert updates[-1][1]==['SecurityGroup']
assert all(v['RuntimePeerSecurityGroup']=='private-peers' for v,_ in updates)
assert all(set(v)==set(p.yaml.safe_load((p.ROOT/'cloudformation/runtime.yaml').read_text())['Parameters']) for v,_ in updates)
names=[e[0] for e in events]
assert names.index('reboot-verified')<names.index('swarm')
checks=[e for e in events if e[0]=='peer-health']
assert [(e[1],e[2]['peer']['instanceId']) for e in checks]==[('old','new'),('new','old')]
assert max(i for i,e in enumerate(events) if e[0]=='peer-health')<names.index('dns')<names.index('promote')
print('bidirectional and ordered')
`)
    ).toBe('bidirectional and ordered');
  });

  test('requires a current security-update receipt after reboot before public peering can open', () => {
    expect(
      python(`
c=object.__new__(p.Controller);c.state={'steps':{'reboot-requested':{'bootId':'before'}},'versions':{'kuboVersion':'0.43.1'}}
p.call=lambda *args:{'InstanceInformationList':[{'PingStatus':'Online'}]};p.time.sleep=lambda _:None
verified=[];c.host=lambda *args,**kwargs:verified.append(True)
base={'bootId':'after','router':{'mode':'serve','mfsReady':False},'version':'0.43.1'}
for extra in [{},{'rebootRequired':True}]:
 c.current_status=lambda _,extra=extra:{**base,**extra}
 try:c.verify_reboot({'instanceId':'new'}, {'cid':'probe'})
 except TimeoutError:pass
 else:raise AssertionError('Unsafe reboot accepted')
assert verified==[]
c.current_status=lambda _:{**base,'rebootRequired':False}
assert c.verify_reboot({'instanceId':'new'}, {'cid':'probe'})['rebootPersistenceVerified']
assert verified==[True]
print('fails closed')
`)
    ).toBe('fails closed');
  });

  test('allows mutual private HTTPS without opening the peer group to the public internet', () => {
    const door = parse(
      readFileSync(join(__dirname, 'cloudformation/frontdoor.yaml'), 'utf8')
    );
    const runtime = parse(
      readFileSync(join(__dirname, 'cloudformation/runtime.yaml'), 'utf8')
    );
    expect(door.Resources.RuntimePeerGroup.Properties).not.toHaveProperty(
      'SecurityGroupIngress'
    );
    expect(door.Resources.RuntimePeerIngress.Properties).toEqual({
      GroupId: { Ref: 'RuntimePeerGroup' },
      SourceSecurityGroupId: { Ref: 'RuntimePeerGroup' },
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443
    });
    expect(
      runtime.Resources.Instance.Properties.NetworkInterfaces[0].GroupSet
    ).toContainEqual({ Ref: 'RuntimePeerSecurityGroup' });
  });

  test('checks private peer TLS using the canonical hostname, recorded certificate and reviewed subnet', () => {
    expect(
      python(`${rejected}
import production_host as h
peer={'instanceId':'other','privateIp':'172.31.20.2','certificate':'recorded-certificate'}
def run(*args):
 assert '--insecure' not in args
 assert args[args.index('--resolve')+1]=='api-ipfs.6529.io:443:172.31.20.2'
 assert Path(args[args.index('--cacert')+1]).read_text()=='recorded-certificate'
 return b'{"Version":"0.43.1"}'
h.host.run=run
assert h.peer_health('self',{'peer':peer})['privateHttpsVerified']
rejected(lambda:h.peer_health('self',{'peer':{**peer,'privateIp':'8.8.8.8'}}))
rejected(lambda:p.validate_receipt({'operation':'peer-health','peer':peer},{'privateHttpsVerified':True,'peerInstanceId':'wrong'}))
print('private TLS verified')
`)
    ).toBe('private TLS verified');
  });

  test('only offers explicit production operations through the protected main environment', () => {
    const workflow = parse(
      readFileSync(
        join(__dirname, '../../.github/workflows/ipfs-manage.yml'),
        'utf8'
      )
    );
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.jobs.manage.environment).toBe('ipfs-prod');
    expect(workflow.on.workflow_dispatch.inputs.operation.options).toEqual([
      'plan',
      'migrate',
      'verify',
      'backup',
      'rollback',
      'promote'
    ]);
    expect(workflow.concurrency).toEqual({
      group: 'ipfs-manage-prod',
      'cancel-in-progress': false
    });
    expect(workflow.jobs.manage.if).toContain('refs/heads/main');
  });
});
