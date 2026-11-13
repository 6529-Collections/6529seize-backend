import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

function python(body: string) {
  return execFileSync(
    'python3',
    [
      '-c',
      `import sys,json,tempfile\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nimport handover_state as h\n${body}`,
      __dirname
    ],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
  ).trim();
}

describe('IPFS writer state transfer', () => {
  test('accepts an empty pin category and retains explicit names without walking implicit pins', () => {
    expect(
      JSON.parse(
        python(`
def call(operation,query):
 assert query['type']!='all' and query['names']=='true'
 return {'Keys':{'old':{'Type':'recursive','Name':'kept-name'}}} if query['type']=='recursive' else {}
print(json.dumps(h.explicit_pins(call)))
`)
      )
    ).toEqual({ pins: { old: 'recursive' }, pinNames: { old: 'kept-name' } });
  });

  test('unions source pins with uploads accepted on the replacement', () => {
    expect(
      python(`
pins={'new-upload':{'Type':'recursive','Name':'new'},'stronger-pin':{'Type':'recursive','Name':'current'}}
def call(op,q,**kwargs):
 if op=='pin/ls':return {'Keys':{k:v for k,v in pins.items() if v['Type']==q['type']}}
 assert op=='pin/add'
 pins[q['arg']]={'Type':'recursive' if q['recursive']=='true' else 'direct','Name':q['name']}
saved={'pins':{'old-upload':'recursive','stronger-pin':'direct'},'pinNames':{'old-upload':'source','stronger-pin':'older'},'mfsRoot':'root'}
h.merge_pins(saved,call)
assert pins['new-upload']['Name']=='new' and pins['stronger-pin']['Name']=='current'
assert pins['old-upload']['Name']=='source'
print('retained')
`)
    ).toBe('retained');
  });

  test('refuses mutable state replacement before a fence or after an unexplained baseline change', () => {
    expect(
      python(`
saved={'pins':{},'pinNames':{},'mfsRoot':'final'}
for ready in [True,False]:
 def call(op,q,**kwargs):
  assert op=='files/stat'
  return {'Hash':'unexpected'}
 with tempfile.TemporaryDirectory() as directory:
  try:h.replace_fenced_mfs(saved,call,lambda:{'mode':'serve','mfsReady':ready,'epoch':1},Path(directory)/'journal.json','migration','base')
  except ValueError:pass
  else:raise AssertionError('Unsafe MFS overwrite accepted')
print('rejected')
`)
    ).toBe('rejected');
  });

  test('resumes an interrupted file transfer without removing destination pins', () => {
    expect(
      python(`
saved={'pins':{'source-pin':'recursive'},'pinNames':{},'mfsRoot':'final'}
entries={'base':'old'};root='base';fail=True;retained=[]
def call(op,q,**kwargs):
 global root,fail
 if op=='files/stat':return {'Hash':root}
 if op=='pin/add':retained.append(q['arg']);return {}
 if op=='files/ls':return {'Entries':[{'Name':name} for name in entries]}
 if op=='files/rm':entries.pop(q['arg'][1:]);root='partial';return {}
 if op=='ls':return {'Objects':[{'Links':[{'Name':'a'},{'Name':'b'}]}]}
 if op=='files/cp':
  name=q['arg'][1][1:]
  if name=='b' and fail:fail=False;raise ConnectionError('interrupted')
  entries[name]='source';root='final' if set(entries)=={'a','b'} else 'partial';return {}
 if op=='files/flush':return {}
 raise AssertionError(op)
with tempfile.TemporaryDirectory() as directory:
 path=Path(directory)/'journal.json'
 args=(saved,call,lambda:{'mode':'serve','mfsReady':False,'epoch':2},path,'migration','base')
 try:h.replace_fenced_mfs(*args)
 except ConnectionError:pass
 else:raise AssertionError('Interruption not exercised')
 h.replace_fenced_mfs(*args)
 assert json.loads(path.read_text())['status']=='complete' and root=='final'
 assert 'base' in retained
print('resumed')
`)
    ).toBe('resumed');
  });
});

describe('production IPFS CloudFormation descriptors', () => {
  test('keeps both target groups attached for health checks and changes only weights for handover', () => {
    const template = parse(
      readFileSync(join(__dirname, 'cloudformation/frontdoor.yaml'), 'utf8')
    );
    expect(template.Parameters.ActiveSlot.AllowedValues).toEqual(['a', 'b']);
    for (const logical of ['ApiRule', 'GatewayRule']) {
      expect(
        template.Resources[logical].Properties.Actions[0].ForwardConfig
          .TargetGroups
      ).toHaveLength(2);
    }
    expect(JSON.stringify(template)).not.toContain(
      'AWS::CloudFront::Distribution'
    );
    expect(JSON.stringify(template)).not.toContain('AWS::Route53::RecordSet');
  });

  test('starts new runtime roles without content writes and always denies content deletion', () => {
    const template = parse(
      readFileSync(join(__dirname, 'cloudformation/runtime.yaml'), 'utf8')
    );
    expect(template.Parameters.AllowWrites.Default).toBe('false');
    const statements =
      template.Resources.Role.Properties.Policies[0].PolicyDocument.Statement;
    expect(statements).toContainEqual({
      Effect: 'Deny',
      Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      Resource: 'arn:aws:s3:::6529ipfs/*'
    });
    expect(template.Resources.Instance.DeletionPolicy).toBe('Retain');
    expect(template.Resources.Instance.Properties.DisableApiTermination).toBe(
      true
    );
  });
});
