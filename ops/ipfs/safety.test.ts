import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const directory = __dirname;
const config = {
  environment: 'staging',
  accountId: '111111111111',
  region: 'us-east-1',
  blocksBucket: 'fixture-blocks',
  backupsBucket: 'fixture-backups',
  artifactsBucket: 'fixture-artifacts',
  originHost: 'origin.fixture.example.com',
  apiHost: 'api.fixture.example.com',
  gatewayHost: 'gateway.fixture.example.com',
  hostedZoneId: 'Z123456789',
  acmeEmail: 'operator@example.com',
  instanceId: 'i-11111111111111111'
};
const sha = 'a'.repeat(40);
const environment = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: '6529-Collections/6529seize-backend',
  GITHUB_REF: 'refs/heads/1a-staging',
  GITHUB_SHA: sha
};

function python(body: string, value: unknown = config) {
  return execFileSync(
    'python3',
    [
      '-c',
      `import sys,json\nsys.path.insert(0,sys.argv[1])\nconfig=json.loads(sys.argv[2])\n${body}`,
      directory,
      JSON.stringify(value)
    ],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
  ).trim();
}

describe('IPFS source, environment and production isolation', () => {
  test('accepts only the reviewed staging source', () => {
    expect(
      python(
        `from common import mutation_guard\nmutation_guard(config,'${sha}',${JSON.stringify(environment)})\nprint('ok')`
      )
    ).toBe('ok');
  });

  test.each([
    ['wrong account format', { accountId: 'unknown' }],
    ['production block store', { blocksBucket: '6529ipfs' }],
    ['production backup store', { backupsBucket: '6529ipfs' }],
    ['production instance', { instanceId: 'i-0012c6236ad1292e8' }],
    ['production DNS', { originHost: 'ipfs-origin.6529.io' }],
    ['shared media alias', { gatewayHost: 'media.6529.io' }],
    ['shared buckets', { backupsBucket: 'fixture-blocks' }],
    ['configuration credentials', { secretKey: 'must-not-be-accepted' }],
    ['email without a public domain', { acmeEmail: 'a@b' }]
  ])('rejects %s before using AWS', (_name, changes) => {
    expect(
      python(
        `from common import validate_config\ntry:\n validate_config(config)\nexcept ValueError:\n print('rejected')`,
        { ...config, ...changes }
      )
    ).toBe('rejected');
  });

  test.each([
    { GITHUB_SHA: 'b'.repeat(40) },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_REPOSITORY: 'attacker/fork' }
  ])('rejects mismatched dispatch identity %j', (changes) => {
    expect(
      python(
        `from common import mutation_guard\ntry:\n mutation_guard(config,'${sha}',${JSON.stringify({ ...environment, ...changes })})\nexcept ValueError:\n print('rejected')`
      )
    ).toBe('rejected');
  });

  test('production remains disabled even from its correct branch and account', () => {
    expect(
      python(
        `from common import mutation_guard\ntry:\n mutation_guard(config,'${sha}',${JSON.stringify({ ...environment, GITHUB_REF: 'refs/heads/main' })})\nexcept ValueError as error:\n print(str(error))`,
        { ...config, environment: 'prod' }
      )
    ).toContain('Production changes are disabled');
  });
});

describe('IPFS infrastructure and state protections', () => {
  test('bootstraps repository/environment OIDC trust and bounded runtime roles', () => {
    const access = JSON.parse(
      python('from infrastructure import access\nprint(json.dumps(access()))')
    );
    const compute = JSON.parse(
      python('from infrastructure import compute\nprint(json.dumps(compute()))')
    );
    expect(
      access.Resources.DeploymentRole.Properties.AssumeRolePolicyDocument
        .Statement[0].Condition.StringEquals[
        'token.actions.githubusercontent.com:sub'
      ]
    ).toEqual({
      'Fn::Sub': '${GitHubRepositorySubject}:environment:ipfs-${Environment}'
    });
    expect(compute.Resources.Role.Properties.PermissionsBoundary).toEqual({
      Ref: 'RuntimeBoundaryArn'
    });
    expect(JSON.stringify(access.Resources.CloudFormationRole)).toContain(
      'iam:PermissionsBoundary'
    );
    expect(JSON.stringify(access.Resources.CloudFormationRole)).toContain(
      'distribution/E1D6I3Z3M5F0H4'
    );
  });

  test('a no-change CloudFormation result is a successful no-op', () => {
    expect(
      python(
        `import control\ncontrol.aws=lambda *args:{'Status':'FAILED','StatusReason':"The submitted information didn't contain changes."}\nprint(control.wait_change_set(config,'fixture') is None)`
      )
    ).toBe('True');
  });

  test('SSM failure is not converted into successful deployment', () => {
    expect(
      python(
        `import control\ncontrol.time.sleep=lambda _:None\ndef aws(*args,**kwargs):\n if args[1]=='describe-instance-information':return {'InstanceInformationList':[{'PingStatus':'Online'}]}\n if args[1]=='send-command':return {'Command':{'CommandId':'fixture'}}\n return {'CommandInvocations':[{'Status':'Success','CommandPlugins':[{'ResponseCode':1}]}]}\ncontrol.aws=aws\ntry:\n control.command(config,'ignored','verify')\nexcept ValueError:\n print('rejected')`
      )
    ).toBe('rejected');
  });

  test('retains every data bucket on deletion and replacement and enables versioning', () => {
    const template = JSON.parse(
      python('from infrastructure import storage\nprint(json.dumps(storage()))')
    );
    for (const name of ['Blocks', 'Backups', 'Artifacts']) {
      expect(template.Resources[name]).toMatchObject({
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
        Properties: { VersioningConfiguration: { Status: 'Enabled' } }
      });
    }
  });

  test('refuses destructive changes and conditional replacements', () => {
    expect(
      python(
        `from control import reject_destructive_changes\nfor change in [{'Action':'Remove'},{'Action':'Modify','Replacement':'True'},{'Action':'Modify','Replacement':'Conditional'}]:\n try:\n  reject_destructive_changes([{'ResourceChange':change}])\n except ValueError:\n  print('rejected')`
      )
    ).toBe('rejected\nrejected\nrejected');
  });

  test('keeps block deletion forbidden, RPC private and the EC2 role narrowly scoped', () => {
    const template = JSON.parse(
      python('from infrastructure import compute\nprint(json.dumps(compute()))')
    );
    const serialized = JSON.stringify(template);
    expect(serialized).toContain('s3:DeleteObjectVersion');
    expect(serialized).not.toContain('s3:*');
    expect(
      template.Resources.SecurityGroup.Properties.SecurityGroupIngress
    ).toEqual([
      {
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        CidrIp: { Ref: 'IngressCidr' }
      }
    ]);
    expect(
      template.Resources.Instance.Properties.MetadataOptions.HttpTokens
    ).toBe('required');
    expect(
      template.Resources.Instance.Properties.UserData['Fn::Base64']['Fn::Sub']
    ).not.toContain('ipfs daemon');
  });

  test('existing active or untagged hosts fail before a command is sent', () => {
    expect(
      python(
        `import control\nfor role in ['active','unknown']:\n control.aws=lambda *args: {'Reservations':[{'Instances':[{'State':{'Name':'running'},'Tags':[{'Key':'Service','Value':'6529-ipfs'},{'Key':'Environment','Value':'staging'},{'Key':'IpfsRole','Value':role}]}]}]}\n try:\n  control.candidate(config)\n except ValueError:\n  print('rejected')`
      )
    ).toBe('rejected\nrejected');
  });

  test('environment data parameters cannot be overridden by workflow inputs', () => {
    expect(
      python(
        `from control import stack_parameters\ntry:\n stack_parameters(config,'compute',{'BlocksBucket':'6529ipfs'})\nexcept ValueError:\n print('rejected')`
      )
    ).toBe('rejected');
  });

  test('offline render works without AWS credentials or a CLI', () => {
    const result = spawnSync(
      'python3',
      [join(directory, 'control.py'), 'validate'],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no AWS credentials');
  });
});

describe('IPFS recovery and artifact integrity', () => {
  test('incomplete restores cannot pass publication verification', () => {
    expect(
      python(
        `import host,tempfile,pathlib\nwith tempfile.TemporaryDirectory() as temporary:\n host.SETTINGS=pathlib.Path(temporary);(host.SETTINGS/'restore-session.json').write_text(json.dumps({'status':'restoring'}))\n try:\n  host.verify({})\n except ValueError as error:\n  print(str(error))`
      )
    ).toBe('Candidate restore is incomplete');
  });

  test('restore retries reject conflicting MFS contents before changing pins', () => {
    expect(
      python(
        `from host import restore_references\ndef rpc(operation,query,**kwargs):\n if operation=='ls':return {'Objects':[{'Links':[{'Name':'entry','Hash':'expected'}]}]}\n if operation=='files/ls':return {'Entries':[{'Name':'entry'}]}\n if operation=='files/stat':return {'Hash':'conflicting'}\n raise AssertionError('Conflicting candidate performed a mutation')\ntry:\n restore_references({'schema':1,'pins':{},'mfsRoot':'root'},rpc)\nexcept ValueError:\n print('rejected')`
      )
    ).toBe('rejected');
  });

  test('receipts survive trailing logs and expose only the operation fields', () => {
    const result = python(
      `from control import parse_receipt\nprint(json.dumps(parse_receipt('setup log\\n'+json.dumps(config)+'\\ntrailing warning','backup')))`,
      {
        protocol: '6529.ipfs.receipt.v1',
        operation: 'backup',
        result: {
          backupKey: 'staging/fixture/metadata.tar.gz',
          versionId: 'version',
          pinCount: 3,
          ignoredPrivateField: 'fixture-only'
        }
      }
    );
    expect(JSON.parse(result)).toEqual({
      backupKey: 'staging/fixture/metadata.tar.gz',
      versionId: 'version',
      pinCount: 3
    });
  });

  test.each([
    {
      output: 'not a receipt',
      expectedError: 'No valid SSM operation receipt'
    },
    {
      output: JSON.stringify({
        protocol: '6529.ipfs.receipt.v1',
        operation: 'backup',
        result: { pinCount: 3 }
      }),
      expectedError: 'Missing or invalid required SSM receipt fields'
    },
    {
      output: JSON.stringify({
        protocol: '6529.ipfs.receipt.v1',
        operation: 'verify',
        result: {}
      }),
      expectedError: 'SSM receipt operation mismatch'
    }
  ])(
    'rejects a receipt with the expected reason: $expectedError',
    ({ output, expectedError }) => {
      expect(
        python(
          `from control import parse_receipt\noutput_text=json.loads(sys.argv[2])\nassert isinstance(output_text,str)\ntry:\n parse_receipt(output_text,'backup')\nexcept ValueError as error:\n print(str(error))`,
          output
        )
      ).toContain(expectedError);
    }
  );

  test('deployment reports a missing runner directory before reading an artifact', () => {
    expect(
      python(
        `import os\nfrom argparse import Namespace\nfrom pathlib import Path\nfrom unittest.mock import patch\nfrom control import host_operation\nos.environ.pop('RUNNER_TEMP',None)\nwith patch('control.candidate'):\n try:\n  host_operation(config,Namespace(operation='deploy',bundle=Path('/unused'),bundle_sha256='a'*64))\n except ValueError as error:\n  print(str(error))`
      )
    ).toBe('RUNNER_TEMP is required for Actions deployment');
  });

  test('hashing rejects a symlink that leaves the permitted artifact directory', () => {
    expect(
      python(
        `import pathlib,tempfile\nfrom common import digest\nwith tempfile.TemporaryDirectory() as temporary:\n root=pathlib.Path(temporary);allowed=root/'allowed';allowed.mkdir();outside=root/'outside';outside.write_text('fixture');link=allowed/'bundle';link.symlink_to(outside)\n try:\n  digest(link,allowed)\n except ValueError:\n  print('rejected')`
      )
    ).toBe('rejected');
  });

  test.each([
    {},
    { Objects: [] },
    { Objects: [{}] },
    { Objects: [{ Links: 'invalid' }] }
  ])('rejects malformed MFS listings cleanly: %j', (listing) => {
    const source = `from host import restore_references\ndef rpc(operation,*args,**kwargs):\n if operation=='ls':return config\n raise AssertionError('Malformed backup performed a mutation')\ntry:\n restore_references({'schema':1,'pins':{},'mfsRoot':'root'},rpc)\nexcept ValueError:\n print('rejected')`;
    expect(python(source, listing)).toBe('rejected');
  });

  test.each(['../escape', '/absolute', 'nested/../../escape'])(
    'rejects archive path %s before extracting any file',
    (name) => {
      expect(
        python(
          `import tempfile,tarfile,io,pathlib\nfrom common import extract\nwith tempfile.TemporaryDirectory() as temporary:\n root=pathlib.Path(temporary);archive=root/'bad.tar.gz'\n with tarfile.open(archive,'w:gz') as target:\n  entry=tarfile.TarInfo(${JSON.stringify(name)});entry.size=1;target.addfile(entry,io.BytesIO(b'x'))\n try:\n  extract(archive,root/'output')\n except ValueError:\n  print('rejected')`
        )
      ).toBe('rejected');
    }
  );

  test('rejects symlinks in backup bundles', () => {
    expect(
      python(
        `import tempfile,tarfile,pathlib\nfrom common import extract\nwith tempfile.TemporaryDirectory() as temporary:\n root=pathlib.Path(temporary);archive=root/'bad.tar.gz'\n with tarfile.open(archive,'w:gz') as target:\n  entry=tarfile.TarInfo('link');entry.type=tarfile.SYMTYPE;entry.linkname='/etc';target.addfile(entry)\n try:\n  extract(archive,root/'output')\n except ValueError:\n  print('rejected')`
      )
    ).toBe('rejected');
  });

  test('restores direct and recursive pins and MFS entries named restored', () => {
    const calls = JSON.parse(
      python(
        `from host import restore_references\ncalls=[]\ndef rpc(operation,query,**kwargs):\n calls.append([operation,query])\n if operation=='pin/ls':return {'Keys':{}}\n if operation=='files/ls':return {'Entries':[]}\n if operation=='ls':return {'Objects':[{'Links':[{'Name':'restored','Hash':'child-r'},{'Name':'nested','Hash':'child-n'}]}]}\n if operation=='files/stat':return {'Hash':'root'}\nrestore_references({'schema':1,'pins':{'recursive':'recursive','direct':'direct'},'mfsRoot':'root'},rpc)\nprint(json.dumps(calls))`
      )
    );
    expect(calls).toContainEqual([
      'pin/add',
      { arg: 'direct', recursive: 'false', name: '' }
    ]);
    expect(calls).toContainEqual([
      'pin/add',
      { arg: 'recursive', recursive: 'true', name: '' }
    ]);
    expect(calls).toContainEqual([
      'files/cp',
      { arg: ['/ipfs/root/restored', '/restored'] }
    ]);
  });

  test('fails recovery on an incorrect MFS root', () => {
    expect(
      python(
        `from host import restore_references\ndef rpc(operation,query,**kwargs):\n if operation=='pin/ls':return {'Keys':{}}\n if operation=='files/ls':return {'Entries':[]}\n if operation=='ls':return {'Objects':[{'Links':[]}]}\n if operation=='files/stat':return {'Hash':'wrong'}\ntry:\n restore_references({'schema':1,'pins':{},'mfsRoot':'expected'},rpc)\nexcept ValueError:\n print('rejected')`
      )
    ).toBe('rejected');
  });

  test('does not back up an unstable pin/MFS view', () => {
    expect(
      python(
        `import host\ncounter=iter(range(20))\nhost.references=lambda:{'mfsRoot':next(counter)}\ntry:\n host.stable_references()\nexcept RuntimeError:\n print('rejected')`
      )
    ).toBe('rejected');
  });
});

test('management only dispatches explicitly and cannot cancel a running deployment', () => {
  const workflow = parse(
    readFileSync(
      join(directory, '../../.github/workflows/ipfs-manage.yml'),
      'utf8'
    )
  );
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  expect(workflow.jobs.manage.environment).toBe(
    'ipfs-${{ inputs.environment }}'
  );
  const yaml = JSON.stringify(workflow);
  expect(yaml).toContain('mutation_guard');
  expect(yaml).toContain('expected_source_sha');
});
