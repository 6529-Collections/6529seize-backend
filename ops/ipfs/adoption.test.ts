import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const directory = __dirname;
const fixture = `
import sys,json,copy
sys.path.insert(0,sys.argv[1])
import adoption as a
manifest,template=a.baseline()
sha='a'*40
role='arn:aws:iam::987989283142:role/seize-ipfs-prod-adoption-service'
models={name:copy.deepcopy(resource['Properties']) for name,resource in template['Resources'].items()}
models['Server']['Volumes']=[{'Device':'/dev/sda1','VolumeId':'vol-fixture'}]
for name,model in models.items():
 manifest['resources'][name]['modelSha256']=a.fingerprint(a.normalize(model,manifest['resources'][name]['readOnlyProperties']))
change_id='arn:aws:cloudformation:us-east-1:987989283142:changeSet/'+a.expected_change_name(sha,manifest)+'/fixture-id'
# Actual DescribeChangeSet shape: AWS returns neither ChangeSetType nor RoleARN.
change={'ChangeSetName':a.expected_change_name(sha,manifest),'ChangeSetId':change_id,'StackName':a.STACK,
 'Description':a.description(sha,manifest),'Status':'CREATE_COMPLETE','ExecutionStatus':'AVAILABLE',
 'Changes':[{'ResourceChange':{'Action':'Import','LogicalResourceId':name,'ResourceType':kind,'PhysicalResourceId':identifier}}
            for name,(kind,key,identifier) in a.EXPECTED.items()]}
calls=[]
summary=None
stack_role=role
drift='IN_SYNC'
def aws(service,operation,*args,**kwargs):
 calls.append((service,operation,args))
 if operation=='get-caller-identity': return {'Account':manifest['accountId']}
 if operation=='get-resource':
  identifier=args[args.index('--identifier')+1]
  name=next(name for name,item in manifest['resources'].items() if item['identifier']==identifier)
  return {'ResourceDescription':{'Identifier':identifier,'Properties':json.dumps(models[name])}}
 if operation=='describe-instances':return {'Reservations':[{'Instances':[{'InstanceId':a.EXPECTED['Server'][2],'State':{'Name':'running'}}]}]}
 if operation=='list-stacks': return {'StackSummaries':[summary] if summary else []}
 if operation=='describe-stacks':return {'Stacks':[{'RoleARN':stack_role}]}
 if operation=='create-change-set':return {'Id':change_id}
 if operation=='describe-change-set':return copy.deepcopy(change)
 if operation=='list-change-sets':return {'Summaries':[{'ChangeSetName':change['ChangeSetName'],'ChangeSetId':change_id}]}
 if operation=='get-template':return {'TemplateBody':template}
 if operation=='list-stack-resources':return {'StackResourceSummaries':[{'LogicalResourceId':name,'ResourceType':kind,'PhysicalResourceId':identifier} for name,(kind,key,identifier) in a.EXPECTED.items()]}
 if operation=='detect-stack-resource-drift':return {'StackResourceDrift':{'StackResourceDriftStatus':drift}}
 if operation in ('execute-change-set','wait','update-termination-protection','set-stack-policy'):return {}
 raise AssertionError('Unexpected AWS operation '+operation)
a.aws=aws
def rejected(call):
 try:call()
 except ValueError as error:return str(error)
 raise AssertionError('Unsafe operation was accepted')
`;

function python(body: string) {
  return execFileSync('python3', ['-c', fixture + '\n' + body, directory], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  }).trim();
}

describe('production IPFS import baseline', () => {
  test('keeps the entire shared CDN and exact current storage settings', () => {
    const baseline = parse(
      readFileSync(join(directory, 'cloudformation/adoption.yaml'), 'utf8')
    );
    const resources = baseline.Resources;
    expect(Object.keys(resources).sort((a, b) => a.localeCompare(b))).toEqual([
      'Blocks',
      'Server',
      'ServerSecurityGroup',
      'SharedDistribution'
    ]);
    for (const resource of Object.values(resources)) {
      expect(resource).toMatchObject({
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain'
      });
    }
    expect(resources.Blocks.Properties.BucketName).toBe('6529ipfs');
    // Import preserves the unversioned bucket; enabling versioning is an update.
    expect(resources.Blocks.Properties.VersioningConfiguration).toBeUndefined();
    const cdn = resources.SharedDistribution.Properties.DistributionConfig;
    expect(cdn.Aliases).toEqual([
      'ipfs-cache.6529.io',
      'ipfs.6529.io',
      'media.6529.io'
    ]);
    expect(
      cdn.CacheBehaviors.map(
        (item: { PathPattern: string }) => item.PathPattern
      )
    ).toEqual(['/ipfs/*', '/arweave/*', '/s3/*']);
    expect(cdn.CacheBehaviors[1].FunctionAssociations).toEqual([
      {
        EventType: 'viewer-request',
        FunctionARN:
          'arn:aws:cloudfront::987989283142:function/media-prefix-router'
      }
    ]);
    expect(cdn.WebACLId).toContain('CreatedByCloudFront-14fdc626');
    expect(python('print(len(a.baseline()[0]["resources"]))')).toBe('4');
  });

  test('plans offline without loading candidate config or using AWS', () => {
    expect(
      JSON.parse(
        python(`
a.aws=lambda *args,**kwargs:(_ for _ in ()).throw(AssertionError('Offline AWS call'))
sys.argv=['adoption.py','plan']
a.main()
`)
      )
    ).toMatchObject({
      stackName: 'seize-ipfs-prod-adopted',
      configurationChanged: false
    });
  });

  test('audits all native properties, including properties omitted from YAML', () => {
    expect(
      JSON.parse(python('print(json.dumps(a.audit(manifest,template)))'))
        .matched
    ).toHaveLength(4);
    expect(
      python(`
models['Server']['Volumes'][0]['VolumeId']='vol-unexpected'
print(rejected(lambda:a.audit(manifest,template)))
`)
    ).toContain('baseline: Server');
  });

  test('checks declared YAML independently of the native-model fingerprint', () => {
    expect(
      python(`
template['Resources']['Server']['Properties']['InstanceType']='m7i.large'
print(rejected(lambda:a.audit(manifest,template)))
`)
    ).toContain('Template properties differ');
  });

  test('refuses a shared legacy security group and a wrong AWS account', () => {
    expect(
      python(`
original=a.aws
def wrong(service,operation,*args,**kwargs):
 if operation=='describe-instances':return {'Reservations':[{'Instances':[{'InstanceId':'i-other','State':{'Name':'running'}}]}]}
 return original(service,operation,*args,**kwargs)
a.aws=wrong
print(rejected(lambda:a.audit(manifest,template)))
`)
    ).toContain('security group is shared');
    expect(
      python(`
a.aws=lambda *args,**kwargs:{'Account':'111111111111'}
print(rejected(lambda:a.audit(manifest,template)))
`)
    ).toContain('account mismatch');
  });

  test('does not ignore custom tags, cache order, or security settings', () => {
    expect(
      python(`
base={'Tags':[{'Key':'Name','Value':'original'}],'Nested':[{'Name':'first'},{'Name':'second'}],'State':'running'}
same=copy.deepcopy(base);same['Tags'].append({'Key':'aws:cloudformation:stack-id','Value':'stack'});same['State']='stopped'
assert a.normalize(base,['/properties/State'])==a.normalize(same,['/properties/State'])
same['Tags'][0]['Value']='changed'
assert a.normalize(base,['/properties/State'])!=a.normalize(same,['/properties/State'])
same=copy.deepcopy(base);same['Nested'].reverse()
assert a.normalize(base,[])!=a.normalize(same,[])
print('ok')
`)
    ).toBe('ok');
  });

  test.each(['prepare', 'execute'])(
    '%s fails closed before any AWS call',
    (operation) => {
      expect(
        python(`
a.os.environ.update(GITHUB_ACTIONS='true',GITHUB_REPOSITORY='6529-Collections/6529seize-backend',GITHUB_REF='refs/heads/main',GITHUB_SHA=sha)
a.aws=lambda *args,**kwargs:(_ for _ in ()).throw(AssertionError('AWS called before guard'))
sys.argv=['adoption.py','${operation}','--sha',sha]
print(rejected(a.main))
`)
      ).toContain('Production adoption is disabled');
    }
  );

  test.each([
    { changesEnabled: true, adoptionEnabled: false },
    { changesEnabled: false, adoptionEnabled: true }
  ])('requires both production switches: %j', (policy) => {
    expect(
      python(`
a.os.environ.update(GITHUB_ACTIONS='true',GITHUB_REPOSITORY='6529-Collections/6529seize-backend',GITHUB_REF='refs/heads/main',GITHUB_SHA=sha)
a.environment_policy=lambda _:json.loads('${JSON.stringify(policy)}')
print(rejected(lambda:a.guarded(sha,mutation=True)))
`)
    ).toContain('Production adoption is disabled');
  });
});

describe('production IPFS import change sets', () => {
  test('submits the checked-in YAML as an explicit import and never executes during prepare', () => {
    const result = JSON.parse(
      python(`
result=a.prepare(manifest,template,sha,role)
request=next(args for service,operation,args in calls if operation=='create-change-set')
print(json.dumps({'result':result,'type':request[request.index('--change-set-type')+1],
 'template':request[request.index('--template-body')+1],
 'imports':json.loads(request[request.index('--resources-to-import')+1]),
 'operations':[operation for service,operation,args in calls]}))
`)
    );
    expect(result.type).toBe('IMPORT');
    expect(result.template).toBe(
      `file://${join(directory, 'cloudformation/adoption.yaml')}`
    );
    expect(result.imports).toHaveLength(4);
    expect(result.result.executed).toBe(false);
    expect(result.operations).not.toContain('execute-change-set');
  });

  test('reconciles a prepared import after interruption without creating another one', () => {
    expect(
      python(`
summary={'StackName':a.STACK,'StackStatus':'REVIEW_IN_PROGRESS'}
a.prepare(manifest,template,sha,role)
assert not any(operation=='create-change-set' for service,operation,args in calls)
print('resumed')
`)
    ).toBe('resumed');
  });

  test.each(['Add', 'Modify', 'Remove'])(
    'rejects %s in an import change set',
    (action) => {
      expect(
        python(`
change['Changes'][0]['ResourceChange']['Action']='${action}'
print(rejected(lambda:a.valid_import_change_set(change,manifest,sha,role)))
`)
      ).toContain('unexpected resource');
    }
  );

  test.each([
    "change['Changes'][0]['ResourceChange']['PhysicalResourceId']='wrong'",
    "change['Changes'].append(change['Changes'][0])",
    "change['Description']='different source'",
    "change['ChangeSetName']='different name'",
    "change['Parameters']=[{'ParameterKey':'unsafe','ParameterValue':'value'}]",
    "change['NextToken']='more'",
    "change['Tags']=[{'Key':'Name','Value':'different'}]",
    "stack_role='arn:aws:iam::987989283142:role/admin'"
  ])('rejects altered import identity: %s', (alteration) => {
    expect(
      python(
        `${alteration}\nprint(rejected(lambda:a.valid_import_change_set(change,manifest,sha,role)))`
      )
    ).toBeTruthy();
  });

  test('refuses execution when the live baseline changed since prepare', () => {
    expect(
      python(`
summary={'StackName':a.STACK,'StackStatus':'REVIEW_IN_PROGRESS'}
models['Blocks']['BucketEncryption']={}
print(rejected(lambda:a.execute(manifest,template,sha,role,change_id)))
assert not any(operation=='execute-change-set' for service,operation,args in calls)
`)
    ).toContain('baseline: Blocks');
  });

  test('rejects a different ARN before any AWS operation', () => {
    expect(
      python(`
print(rejected(lambda:a.execute(manifest,template,sha,role,change_id.replace('987989283142','111111111111'))))
assert not calls
`)
    ).toContain('exact prepared import change-set ARN');
  });

  test('refuses a mismatched original template before execution', () => {
    expect(
      python(`
original=a.aws
def different(service,operation,*args,**kwargs):
 if operation=='get-template':return {'TemplateBody':{'Resources':{}}}
 return original(service,operation,*args,**kwargs)
a.aws=different
print(rejected(lambda:a.execute(manifest,template,sha,role,change_id)))
assert not any(operation=='execute-change-set' for service,operation,args in calls)
`)
    ).toContain('differs from the reviewed YAML');
  });

  test('resumes the exact executing change set without executing twice', () => {
    expect(
      python(`
change['ExecutionStatus']='EXECUTE_IN_PROGRESS'
summary={'StackName':a.STACK,'StackStatus':'IMPORT_COMPLETE'}
result=a.execute(manifest,template,sha,role,change_id)
operations=[operation for service,operation,args in calls]
assert 'execute-change-set' not in operations
assert operations.count('detect-stack-resource-drift')==4
assert 'set-stack-policy' in operations and 'update-termination-protection' in operations
assert result['ownershipVerified'] and result['driftStatus']=='IN_SYNC'
print('verified')
`)
    ).toBe('verified');
  });

  test('never falls back from a failed AWS read to creating or updating infrastructure', () => {
    expect(
      python(`
original=a.aws
def fail(service,operation,*args,**kwargs):
 if operation=='list-stacks':raise ValueError('AccessDenied')
 return original(service,operation,*args,**kwargs)
a.aws=fail
print(rejected(lambda:a.prepare(manifest,template,sha,role)))
assert not any(operation=='create-change-set' for service,operation,args in calls)
`)
    ).toBe('AccessDenied');
  });

  test.each(['MODIFIED', 'DELETED', 'NOT_CHECKED'])(
    'cannot verify %s resources',
    (status) => {
      expect(
        python(`
summary={'StackName':a.STACK,'StackStatus':'IMPORT_COMPLETE'}
drift='${status}'
print(rejected(lambda:a.verify(manifest,template)))
`)
      ).toContain('drifted or unchecked');
    }
  );

  test('keeps import authority separate from deployment and traffic changes', () => {
    const access = parse(
      readFileSync(
        join(directory, 'cloudformation/adoption-access.yaml'),
        'utf8'
      )
    );
    const reader =
      access.Resources.ReadPolicy.Properties.PolicyDocument.Statement;
    const allowed = reader.filter(
      (statement: { Effect: string }) => statement.Effect === 'Allow'
    );
    expect(
      allowed
        .flatMap((statement: { Action: string[] }) => statement.Action)
        .every((action: string) => /:(Get|List|Describe)/.test(action))
    ).toBe(true);
    const denied = reader.find(
      (statement: { Effect: string }) => statement.Effect === 'Deny'
    ).Action;
    expect(denied).toEqual(
      expect.arrayContaining([
        'ssm:SendCommand',
        'route53:ChangeResourceRecordSets',
        'cloudfront:UpdateDistribution',
        's3:PutObject*'
      ])
    );
    const policy =
      access.Resources.AdoptionRole.Properties.Policies[0].PolicyDocument
        .Statement;
    const create = policy.find((statement: { Action: string[] }) =>
      statement.Action.includes('cloudformation:CreateChangeSet')
    );
    expect(create.Condition.Null['cloudformation:ImportResourceTypes']).toBe(
      'false'
    );
    expect(create.Resource).toBe(
      'arn:aws:cloudformation:us-east-1:987989283142:stack/seize-ipfs-prod-adopted/*'
    );
  });
});
