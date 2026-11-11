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
