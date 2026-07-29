export function renderDeployBusUI(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>6529 Release Bus</title>
  <meta name="theme-color" content="#050505">
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#080808;color:#f4f4f5;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px}
    main{max-width:1240px;margin:auto;display:grid;gap:16px}
    header,.panel{border:1px solid #2d2d30;background:#111113;border-radius:16px;padding:20px}
    h1,h2,h3,h4,h5{margin:0}
    h1{font-size:25px}
    h2{font-size:21px}
    h3{font-size:16px}
    h4{font-size:14px}
    h5{font-size:13px}
    p{margin:6px 0}
    .header-title,.auth-summary,.auth-connected,.auth-form,.row,.actions,.lane-title,.filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .header-title{justify-content:flex-start}
    .auth-summary{margin-top:6px}
    .auth-form{margin-top:10px}
    .auth-form input{width:min(420px,100%)}
    .row{justify-content:space-between;align-items:flex-start}
    .lane-title{gap:10px}
    .environment-stack,.stack,.cards,.train-list,.repository-groups{display:grid;gap:12px}
    .environment-panel{display:grid;gap:18px}
    .environment-header{border-bottom:1px solid #27272a;padding-bottom:14px}
    .heads{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .head-card,.train-slot,.repository-group,.card{border:1px solid #303036;background:#0b0b0d;border-radius:12px;padding:14px}
    .head-card{display:grid;gap:8px}
    .head-pair{display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px;align-items:start}
    .train-slot{display:grid;gap:10px}
    .train-slot>h3{padding-bottom:4px}
    .train-card{border:1px solid #3f3f46;background:#101012;border-radius:12px;padding:14px;display:grid;gap:14px}
    .train-meta{display:flex;gap:18px;flex-wrap:wrap;color:#a1a1aa;font-size:13px}
    .repository-groups{grid-template-columns:repeat(2,minmax(0,1fr))}
    .repository-group{min-width:0}
    .repository-group>h5{margin-bottom:8px}
    .pr-list{display:grid;gap:8px}
    .pr-card{border:1px solid #27272a;background:#09090b;border-radius:10px;padding:11px;display:grid;gap:7px;min-width:0}
    .pr-title{display:flex;gap:8px;align-items:flex-start;justify-content:space-between}
    .pr-title>div{min-width:0}
    .pr-title a{color:#93c5fd;text-decoration:none;font-weight:700}
    .pr-title a:hover{text-decoration:underline}
    .sha{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
    .short-sha{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    .muted{color:#a1a1aa}
    .small{font-size:13px}
    .compact{padding:5px 9px!important;font-size:13px!important}
    .badge{display:inline-flex;align-items:center;border:1px solid #52525b;border-radius:999px;padding:2px 8px;font-size:12px;white-space:nowrap}
    .badge.on,.badge.success{border-color:#166534;color:#86efac;background:#052e16}
    .badge.off,.badge.failed{border-color:#7f1d1d;color:#fca5a5;background:#450a0a}
    .badge.warning{border-color:#854d0e;color:#fde68a;background:#422006}
    .badge.frontend{border-color:#1d4ed8;color:#bfdbfe;background:#172554}
    .badge.backend{border-color:#6d28d9;color:#ddd6fe;background:#2e1065}
    .field{display:grid;gap:6px}
    .wide{grid-column:1/-1}
    label{font-weight:650}
    input,select,textarea,button{font:inherit;border-radius:10px}
    input,select,textarea{width:100%;border:1px solid #3f3f46;background:#09090b;color:#fafafa;padding:10px 12px}
    input[type=checkbox]{width:auto}
    textarea{min-height:76px;resize:vertical}
    button,a.button{border:1px solid #4b5563;background:#27272a;color:white;padding:8px 12px;text-decoration:none;cursor:pointer}
    button.primary{background:#2563eb;border-color:#3b82f6}
    button.danger{background:#7f1d1d;border-color:#ef4444}
    button:disabled{opacity:.5;cursor:not-allowed}
    button:hover:not(:disabled),a.button:hover{border-color:#71717a;background:#3f3f46}
    :focus-visible{outline:3px solid #60a5fa;outline-offset:2px}
    .icon-button{display:inline-grid;place-items:center;width:28px;height:28px;border:0;background:transparent;color:#a1a1aa;font-size:15px;line-height:1;text-decoration:none;border-radius:7px}
    .icon-button:hover{color:#f4f4f5;background:#27272a}
    .actions{margin-top:8px}
    .status{min-height:24px;margin-top:8px}
    .auth-form+.status:empty{display:none}
    .error{color:#fca5a5}
    .success-text{color:#86efac}
    .warning-text{color:#fde68a}
    .empty{border:1px dashed #3f3f46;border-radius:10px;padding:16px;color:#a1a1aa}
    .metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
    .metric{border:1px solid #27272a;border-radius:8px;padding:8px;min-width:0}
    .metric strong{display:block;margin-top:2px;overflow-wrap:anywhere}
    .list{margin:6px 0;padding-left:20px}
    .filters{display:grid;grid-template-columns:minmax(180px,1fr) minmax(220px,1fr);gap:12px;margin:12px 0}
    .filter-row{justify-content:space-between;margin-top:12px}
    details.diagnostics{border-top:1px solid #27272a;padding-top:10px}
    details.diagnostics>summary,details.registration>summary{cursor:pointer;font-weight:700;list-style-position:outside}
    .diagnostic-body{display:grid;gap:10px;margin-top:10px}
    .operation{border-left:3px solid #3f3f46;padding-left:10px}
    .registration{border:1px solid #303036;border-radius:12px;padding:12px;margin-top:12px}
    .registration-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:12px}
    .hidden{display:none!important}
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    @media(max-width:820px){
      .heads,.repository-groups,.filters,.registration-form,.metrics{grid-template-columns:minmax(0,1fr)}
      .head-pair{grid-template-columns:1fr}
      .row{display:grid}
      .pr-title{display:grid}
      .pr-title .badge{max-width:100%;white-space:normal;overflow-wrap:anywhere}
      header,.panel{padding:16px}
    }
  </style>
</head>
<body>
<main>
  <header>
    <div class="header-title">
      <h1>Release Bus</h1>
      <a class="icon-button" href="/deploy/ui" aria-label="Advanced deployment console" title="Advanced deployment console">&#9881;</a>
    </div>
    <div class="auth-summary">
      <div id="auth-connected" class="auth-connected hidden">
        <span id="auth-identity" class="muted"></span>
        <button id="forget" class="compact">Forget Token</button>
      </div>
      <button id="show-auth" class="compact">Authenticate</button>
    </div>
    <div id="auth-form" class="auth-form hidden">
      <input id="token" type="password" autocomplete="off" spellcheck="false" aria-label="GitHub token" placeholder="Paste GitHub token">
      <button id="connect" class="primary compact">Connect</button>
    </div>
    <div id="auth-status" class="status" role="status" aria-live="polite"></div>
  </header>

  <div id="dashboard" class="environment-stack" aria-busy="true">
    <section id="staging-environment" class="panel environment-panel" aria-labelledby="staging-heading">
      <div class="environment-header">
        <div id="staging-header"><h2 id="staging-heading">Staging</h2></div>
        <div id="staging-control-status" class="status operator hidden" role="status" aria-live="polite"></div>
      </div>
      <div id="staging-heads" class="heads"></div>
      <div id="staging-current" class="train-slot"><h3>Current train</h3><div class="empty">Loading current staging train…</div></div>
      <div id="staging-next" class="train-slot"><h3>Next train if nothing changes</h3><div class="empty">Calculating the current queue…</div></div>
      <div id="staging-previous" class="train-slot"><h3>Previous trains</h3><div class="empty">Loading train history…</div></div>
    </section>

    <section id="production-environment" class="panel environment-panel" aria-labelledby="production-heading">
      <div class="environment-header">
        <div id="production-header"><h2 id="production-heading">Production</h2></div>
        <div id="production-control-status" class="status operator hidden" role="status" aria-live="polite"></div>
      </div>
      <div id="production-heads" class="heads"></div>
      <div id="production-current" class="train-slot"><h3>Current train</h3><div class="empty">Loading current production train…</div></div>
      <div id="production-next" class="train-slot"><h3>Next train if nothing changes</h3><div class="empty">Calculating the current queue…</div></div>
      <div id="production-previous" class="train-slot"><h3>Previous trains</h3><div class="empty">Loading train history…</div></div>
    </section>

    <section class="panel" aria-labelledby="pull-requests-heading">
      <div class="row">
        <div>
          <h2 id="pull-requests-heading">Pull requests</h2>
          <p class="muted">Every registered exact SHA, across both lanes and repositories.</p>
        </div>
        <button id="mark-selection" class="primary compact operator hidden">Mark selected for production</button>
      </div>
      <div class="filters">
        <div class="field">
          <label for="pr-filter">PR number</label>
          <input id="pr-filter" type="number" min="1" inputmode="numeric" placeholder="All PR numbers">
        </div>
        <div class="field">
          <label for="status-filter">Status</label>
          <select id="status-filter"><option value="">All statuses</option></select>
        </div>
      </div>
      <div id="production-selection-status" class="status" role="status" aria-live="polite"></div>
      <div id="pull-requests" class="cards"></div>
      <div class="filter-row">
        <span id="pull-request-count" class="muted small"></span>
        <button id="load-more-prs" class="compact">Load 10 more</button>
      </div>

      <details class="registration operator hidden">
        <summary>Register another PR</summary>
        <form id="register-form" class="registration-form">
          <div class="field">
            <label for="repository">Repository</label>
            <select id="repository"><option value="frontend">Frontend</option><option value="backend">Backend</option></select>
          </div>
          <div class="field">
            <label for="pr-number">PR number</label>
            <input id="pr-number" type="number" min="1" required>
          </div>
          <div class="field">
            <label for="branch">Branch</label>
            <input id="branch" required pattern="[A-Za-z0-9._/-]+">
          </div>
          <div class="field wide">
            <label for="sha">Exact head SHA</label>
            <input id="sha" required pattern="[a-fA-F0-9]{40}" maxlength="40" class="sha">
          </div>
          <div id="backend-plan" class="wide hidden">
            <div class="heads">
              <div class="field">
                <label for="units">Backend deploy units</label>
                <textarea id="units" placeholder="dbMigrationsLoop&#10;api"></textarea>
              </div>
              <div class="field">
                <label for="edges">Unit DAG edges</label>
                <textarea id="edges" placeholder="dbMigrationsLoop -> api"></textarea>
              </div>
            </div>
          </div>
          <div class="field wide">
            <label for="dependencies">Candidate dependencies</label>
            <textarea id="dependencies" placeholder="candidate-uuid:BOTH"></textarea>
            <span class="muted small">One candidate UUID plus STAGING, PRODUCTION, or BOTH per line.</span>
          </div>
          <div class="actions wide">
            <button id="resolve" type="button">Resolve current SHA</button>
            <button id="register" class="primary" type="submit">Register for staging</button>
          </div>
          <div id="register-status" class="status wide" role="status" aria-live="polite"></div>
        </form>
      </details>
    </section>
  </div>
  <div id="dashboard-status" class="sr-only" role="status" aria-live="polite"></div>
</main>
<script src="/deploy/ui/bus/app.js" defer></script>
</body>
</html>`;
}

export function renderDeployBusUiApp(): string {
  return String.raw`'use strict';
(function(){
  var key='deploy-ui-token';
  var terminal=['STAGING_VALIDATED','STAGING_ROLLBACK_FAILED','PRODUCTION_DEPLOYED','FAILED','CANCELLED','DEREGISTERED'];
  var candidateStatuses=['READY_FOR_STAGING','STAGING_IN_TRAIN','STAGING_BUILDING','STAGING_DEPLOYING','STAGING_DEPLOYED','STAGING_VALIDATING','STAGING_VALIDATED','READY_FOR_PRODUCTION','READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION','WAITING_FOR_PRODUCTION_REPLAN','PRODUCTION_IN_TRAIN','PRODUCTION_BUILDING_OR_QUALIFYING','PRODUCTION_DEPLOYING','PRODUCTION_DEPLOYED','NEEDS_REBASE','WAITING_FOR_DEPENDENCY','SUPERSEDED','FAILED','CANCELLED','DEREGISTERED'];
  var state={
    token:localStorage.getItem(key)||'',
    operator:false,
    lanes:{},
    controls:null,
    candidates:[],
    candidateById:{},
    trains:[],
    manifests:[],
    trainDetails:{},
    queueWarnings:{STAGING:'',PRODUCTION:''},
    previousVisible:{STAGING:1,PRODUCTION:1},
    prVisible:10,
    refreshing:false
  };
  var byId=function(id){return document.getElementById(id)};
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(character){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]})}
  function parseJson(value){if(!value)return null;if(typeof value==='object')return value;try{return JSON.parse(value)}catch(_error){return null}}
  function status(node,message,error){if(!node)return;node.textContent=message||'';node.className='status '+(error?'error':'success-text')}
  function headers(){var result={'Content-Type':'application/json'};if(state.token)result.Authorization='Bearer '+state.token;return result}
  async function request(url,options){
    var controller=new AbortController(),timer=setTimeout(function(){controller.abort()},20000);
    try{
      var response=await fetch(url,Object.assign({},options||{},{signal:controller.signal,headers:Object.assign({},headers(),options&&options.headers||{})}));
      var payload=await response.json().catch(function(){return{}});
      if(!response.ok)throw new Error(payload.error||payload.message||('Request failed ('+response.status+')'));
      return payload
    }finally{clearTimeout(timer)}
  }
  function setOperator(connected){
    state.operator=connected;
    Array.prototype.forEach.call(document.querySelectorAll('.operator'),function(node){node.classList.toggle('hidden',!connected)})
  }
  function dateTime(value){
    if(!Number(value))return 'Not recorded';
    return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'medium'}).format(new Date(Number(value)))
  }
  function duration(start,end){
    var startValue=Number(start),endValue=Number(end)||Date.now();
    if(!startValue)return 'Not recorded';
    var seconds=Math.floor(Math.max(0,endValue-startValue)/1000),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60);
    return hours?hours+'h '+minutes%60+'m':minutes?minutes+'m '+seconds%60+'s':seconds+'s'
  }
  function laneKey(lane){return lane==='STAGING'?'STAGING':'PRODUCTION'}
  function laneLabel(lane){return laneKey(lane)==='STAGING'?'Staging':'Production'}
  function repositoryLabel(repository){return repository==='backend'?'Backend':'Frontend'}
  function prUrl(item){return 'https://github.com/6529-Collections/6529seize-'+encodeURIComponent(item.repository)+'/pull/'+encodeURIComponent(item.pr_number)}
  function runUrl(repository,id){return repository&&/^\d+$/.test(String(id||''))?'https://github.com/6529-Collections/6529seize-'+encodeURIComponent(repository)+'/actions/runs/'+encodeURIComponent(id):''}
  function safeHttpsUrl(value){try{var parsed=new URL(String(value||''));return parsed.protocol==='https:'?parsed.href:''}catch(_error){return ''}}
  function badge(value,extra){return '<span class="badge '+esc(extra||'')+'">'+esc(value)+'</span>'}
  function empty(message){return '<div class="empty">'+esc(message)+'</div>'}
  function statusTone(value){
    if(['STAGING_VALIDATED','PRODUCTION_DEPLOYED','SUCCEEDED','ON','LIVE'].includes(value))return 'success';
    if(['FAILED','CANCELLED','DEREGISTERED','DETACHED','DETACHED_MANUAL_OWNERSHIP','STAGING_ROLLBACK_FAILED','OFF'].includes(value))return 'failed';
    if(['READY_FOR_STAGING','READY_FOR_PRODUCTION','READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION','WAITING_FOR_DEPENDENCY','WAITING_FOR_PRODUCTION_REPLAN','PAUSED'].includes(value))return 'warning';
    return ''
  }
  function candidateMembership(data,candidateId){
    return (data&&data.memberships||[]).find(function(item){return item.candidate_id===candidateId})||null
  }
  function dependencyLabel(dependency){
    var prerequisite=state.candidateById[dependency.prerequisite_candidate_id];
    return prerequisite?repositoryLabel(prerequisite.repository)+' PR #'+prerequisite.pr_number:dependency.prerequisite_candidate_id
  }
  function dagMarkup(item,dependencies){
    var plan=parseJson(item.deploy_plan_json)||{},units=Array.isArray(plan.units)?plan.units:[],edges=Array.isArray(plan.edges)?plan.edges:[];
    var candidateDependencies=(dependencies||item.dependencies||[]).map(function(dependency){return '<li>'+esc(dependencyLabel(dependency))+' · '+esc(dependency.environment)+'</li>'}).join('');
    var graph=edges.map(function(edge){return Array.isArray(edge)?esc(edge.join(' → ')):esc(edge)}).join(', ');
    var parts=[];
    if(units.length)parts.push('<div><strong>Deploy units:</strong> '+esc(units.join(', '))+'</div>');
    if(graph)parts.push('<div><strong>DAG:</strong> '+graph+'</div>');
    if(candidateDependencies)parts.push('<div><strong>Depends on:</strong><ul class="list">'+candidateDependencies+'</ul></div>');
    return parts.length?'<div class="small muted">'+parts.join('')+'</div>':''
  }
  function candidateActions(item){
    if(!state.operator)return '';
    var productionOn=state.lanes.PRODUCTION&&state.lanes.PRODUCTION.status==='ON';
    var canMark=item.status==='STAGING_VALIDATED'&&productionOn;
    var canRevoke=['READY_FOR_PRODUCTION','READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION','WAITING_FOR_PRODUCTION_REPLAN'].includes(item.status);
    var canCancel=['READY_FOR_STAGING','READY_FOR_PRODUCTION','READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION','WAITING_FOR_PRODUCTION_REPLAN','NEEDS_REBASE','WAITING_FOR_DEPENDENCY'].includes(item.status);
    return '<div class="actions">'+
      (canMark?'<label class="small"><input type="checkbox" data-select-production="'+esc(item.id)+'" data-sha="'+esc(item.head_sha)+'" data-version="'+esc(item.row_version)+'"> Select for production</label>':'')+
      (canRevoke?'<button class="compact" data-revoke="'+esc(item.id)+'" data-version="'+esc(item.row_version)+'">Revoke readiness</button>':'')+
      (canCancel?'<button class="danger compact" data-cancel="'+esc(item.id)+'" data-version="'+esc(item.row_version)+'">Cancel</button>':'')+
      '</div>'
  }
  function candidateCard(item,options){
    var membership=options&&options.membership;
    var dependencies=options&&options.dependencies||item.dependencies||[];
    var role=membership?(badge(membership.candidate_role||'MEMBER','')+' '+badge(membership.disposition||'INCLUDED','')):'';
    var updatedLabel=options&&options.projected?'Queued '+dateTime(item.updated_at):'Updated '+dateTime(item.updated_at);
    return '<article class="pr-card">'+
      '<div class="pr-title"><div><span class="badge '+esc(item.repository)+'">'+esc(repositoryLabel(item.repository))+'</span> <a target="_blank" rel="noreferrer" href="'+esc(prUrl(item))+'">PR #'+esc(item.pr_number)+'</a></div><div>'+badge(item.status,statusTone(item.status))+' '+role+'</div></div>'+
      '<div class="sha">'+esc(item.head_sha)+'</div>'+
      '<div class="muted small">'+esc(updatedLabel)+(item.hold_reason?' · '+esc(item.hold_reason):'')+'</div>'+
      dagMarkup(item,dependencies)+
      (options&&options.actions===false?'':candidateActions(item))+
      '</article>'
  }
  function repositoryGroups(candidates,data,projected){
    return ['backend','frontend'].map(function(repository){
      var items=candidates.filter(function(item){return item.repository===repository});
      return '<section class="repository-group" aria-label="'+esc(repositoryLabel(repository))+' pull requests">'+
        '<h5>'+esc(repositoryLabel(repository))+' PRs '+badge(items.length,repository)+'</h5>'+
        '<div class="pr-list">'+(items.length?items.map(function(item){
          return candidateCard(item,{
            membership:candidateMembership(data,item.id),
            dependencies:(data&&data.dependencies||[]).filter(function(dependency){return dependency.candidate_id===item.id}),
            projected:Boolean(projected),
            actions:false
          })
        }).join(''):empty('No '+repository+' PRs in this train.'))+'</div></section>'
    }).join('')
  }
  function operationCard(item){
    var workflow=item.workflow_run,workflowUrl=safeHttpsUrl(workflow&&workflow.html_url)||runUrl(item.repository,item.external_id);
    return '<article class="operation">'+
      '<div class="row"><strong>'+esc(item.operation_type)+(item.service?' · '+esc(item.service):'')+'</strong>'+badge(item.status,statusTone(item.status))+'</div>'+
      '<div class="muted small">'+esc(item.repository||'control')+' / '+esc(item.environment||'orchestration')+' · attempt '+esc(item.attempt)+'/'+esc(item.max_attempts)+'</div>'+
      '<div class="small">Started '+esc(dateTime(item.started_at||item.created_at))+' · elapsed '+esc(duration(item.started_at||item.created_at,item.completed_at))+'</div>'+
      (item.expected_sha?'<div class="sha small">Expected '+esc(item.expected_sha)+'</div>':'')+
      (item.failure_message?'<p class="error"><strong>'+esc(item.failure_class||'Failure')+':</strong> '+esc(item.failure_message)+'</p>':'')+
      (item.workflow_observation_error?'<p class="warning-text">'+esc(item.workflow_observation_error)+'</p>':'')+
      (workflowUrl?'<div class="actions"><a class="button compact" target="_blank" rel="noreferrer" href="'+esc(workflowUrl)+'">Open workflow</a></div>':'')+
      '</article>'
  }
  function diagnostics(data){
    var train=data.train,events=data.events||[],operations=data.operations||[];
    var locks=(state.controls&&state.controls.locks||[]).filter(function(lock){return lock.owner_train_id===train.id});
    var manifests=state.manifests.filter(function(manifest){return manifest.train_id===train.id});
    return '<details class="diagnostics"><summary>Diagnostics and immutable evidence</summary><div class="diagnostic-body">'+
      '<div class="metrics">'+
        '<div class="metric"><span class="muted">Train ID</span><strong class="sha">'+esc(train.id)+'</strong></div>'+
        '<div class="metric"><span class="muted">Manifest</span><strong class="sha">'+esc(train.manifest_id||'Not created')+'</strong></div>'+
        '<div class="metric"><span class="muted">Frontend artifact</span><strong class="sha">'+esc(train.frontend_artifact_digest||'Not created')+'</strong></div>'+
        '<div class="metric"><span class="muted">Backend artifact</span><strong class="sha">'+esc(train.backend_artifact_digest||'Not created')+'</strong></div>'+
      '</div>'+
      (train.failure_message?'<p class="error"><strong>'+esc(train.failure_class||'Failure')+':</strong> '+esc(train.failure_message)+'</p>':'')+
      (train.recovery_message?'<p class="muted">'+esc(train.recovery_message)+'</p>':'')+
      '<section><h4>Environment ownership</h4>'+(locks.length?'<ul class="list">'+locks.map(function(lock){return '<li>'+esc(lock.name)+' · lease expires '+esc(dateTime(lock.expires_at))+'</li>'}).join('')+'</ul>':empty('This train does not currently hold an environment lock.'))+'</section>'+
      '<section><h4>Manifests and E2E evidence</h4>'+(manifests.length?'<div class="stack">'+manifests.map(function(manifest){var e2eUrl=runUrl('frontend',manifest.e2e_run_id);return '<article class="operation"><div class="row"><span class="sha">'+esc(manifest.id)+'</span>'+badge(manifest.status,statusTone(manifest.status))+'</div><div class="muted small">Deployed '+esc(dateTime(manifest.deployed_at))+' · validated '+esc(dateTime(manifest.validated_at))+'</div>'+(e2eUrl?'<div class="actions"><a class="button compact" target="_blank" rel="noreferrer" href="'+esc(e2eUrl)+'">Open E2E workflow</a></div>':'')+'</article>'}).join('')+'</div>':empty('No immutable manifest has been recorded for this train.'))+'</section>'+
      '<section><h4>Operations</h4><div class="stack">'+(operations.length?operations.map(operationCard).join(''):empty('No operations recorded for this train.'))+'</div></section>'+
      '<section><h4>Durable events</h4>'+(events.length?'<ul class="list">'+events.map(function(event){return '<li>'+esc(dateTime(event.created_at))+' · '+esc(event.event_type)+'</li>'}).join('')+'</ul>':empty('No durable events recorded.'))+'</section>'+
      '</div></details>'
  }
  function trainCard(data,options){
    var train=data.train,candidates=(data.candidates||[]).filter(Boolean);
    var label=options&&options.label||laneLabel(train.lane)+' train';
    return '<article class="train-card">'+
      '<div class="row"><div><h4>'+esc(label)+'</h4><div class="train-meta"><span>Started '+esc(dateTime(train.created_at))+'</span><span>Status since '+esc(dateTime(train.phase_started_at||train.updated_at))+'</span>'+(train.completed_at?'<span>Completed '+esc(dateTime(train.completed_at))+'</span>':'')+'</div></div>'+badge(train.status,statusTone(train.status))+'</div>'+
      '<div class="metrics">'+
        '<div class="metric"><span class="muted">Frontend release SHA</span><strong class="sha">'+esc(train.frontend_composed_sha||train.frontend_base_sha||'Not available')+'</strong></div>'+
        '<div class="metric"><span class="muted">Backend release SHA</span><strong class="sha">'+esc(train.backend_composed_sha||train.backend_base_sha||'Not available')+'</strong></div>'+
        '<div class="metric"><span class="muted">Elapsed</span><strong>'+esc(duration(train.created_at,train.completed_at))+'</strong></div>'+
        '<div class="metric"><span class="muted">PRs</span><strong>'+esc(candidates.length)+'</strong></div>'+
      '</div>'+
      '<div class="repository-groups">'+repositoryGroups(candidates,data,false)+'</div>'+
      diagnostics(data)+
      '</article>'
  }
  function projectedTrainCard(lane,candidates,blocked){
    return '<article class="train-card">'+
      '<div class="row"><div><h4>Projected '+esc(laneLabel(lane).toLowerCase())+' train</h4><p class="muted small">Calculated from the current exact queue. This mutable projection is not claim evidence; the scheduler revalidates the exact set. No train has been claimed and no state was changed.</p></div>'+badge(blocked?'BLOCKED':'READY',blocked?'warning':'success')+'</div>'+
      (blocked?'<p class="warning-text">'+esc(blocked)+'</p>':'')+
      '<div class="repository-groups">'+repositoryGroups(candidates,null,true)+'</div>'+
      '</article>'
  }
  async function trainDetail(id){
    if(!state.trainDetails[id])state.trainDetails[id]=request('/deploy/release-bus-v2/trains/'+encodeURIComponent(id)).catch(function(error){delete state.trainDetails[id];throw error});
    return state.trainDetails[id]
  }
  async function trainDetailSlot(id){
    try{return{detail:await trainDetail(id),error:null}}catch(error){return{detail:null,error:error}}
  }
  function trainDetailError(label,error){
    return '<article class="train-card"><h4>'+esc(label)+'</h4><p class="error">Train details are temporarily unavailable: '+esc(error&&error.message||'Request failed')+'</p></article>'
  }
  function laneTrains(lane){
    return state.trains.filter(function(train){return train.lane===lane}).sort(function(left,right){return Number(right.created_at)-Number(left.created_at)})
  }
  function activeTrain(lane){
    return laneTrains(lane).find(function(train){return !terminal.includes(train.status)})||null
  }
  function queuedCandidates(lane){
    var statuses=lane==='STAGING'?['READY_FOR_STAGING','WAITING_FOR_DEPENDENCY']:['READY_FOR_PRODUCTION','READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION','WAITING_FOR_PRODUCTION_REPLAN'];
    var active=activeTrain(lane),activeId=active&&active.id;
    var queued=state.candidates.filter(function(candidate){return statuses.includes(candidate.status)&&(!activeId||candidate.current_train_id!==activeId)});
    state.queueWarnings[lane]='';
    if(lane==='PRODUCTION'&&queued.length){
      var ordered=queued.slice().sort(function(left,right){return Number(left.production_requested_at||left.created_at)-Number(right.production_requested_at||right.created_at)});
      var replanning=ordered.some(function(candidate){return candidate.status==='WAITING_FOR_PRODUCTION_REPLAN'});
      var missingSelection=ordered.some(function(candidate){return !candidate.production_selection_id});
      if(replanning){
        queued=ordered;
        if(missingSelection)state.queueWarnings.PRODUCTION='At least one explicit intent has no selection provenance. The scheduler will fail closed or omit it after exact revalidation.'
      }else{
        var selection=ordered[0].production_selection_id||null;
        if(selection){
          queued=ordered.filter(function(candidate){return candidate.production_selection_id===selection})
        }else{
          queued=ordered.slice(0,1);
          state.queueWarnings.PRODUCTION='Production selection provenance is unavailable. Only the earliest intent is shown and the claimed set cannot be projected safely.'
        }
      }
    }
    if(lane==='STAGING'&&queued.length){
      var proposedByPr={};
      queued.forEach(function(candidate){proposedByPr[candidate.repository+':'+candidate.pr_number]=candidate});
      state.candidates.filter(function(candidate){return candidate.staging_live_state==='LIVE'}).forEach(function(candidate){
        var identity=candidate.repository+':'+candidate.pr_number;
        if(!proposedByPr[identity])proposedByPr[identity]=candidate
      });
      queued=Object.keys(proposedByPr).map(function(identity){return proposedByPr[identity]})
    }
    return queued
  }
  function queueBlocker(lane,candidates){
    if(state.queueWarnings[lane])return state.queueWarnings[lane];
    var held=candidates.find(function(candidate){return candidate.status==='WAITING_FOR_DEPENDENCY'});
    return held?'At least one queued PR is waiting for a dependency. The final claimed set may be smaller or may wait.':''
  }
  function manifestById(id){return state.manifests.find(function(manifest){return manifest.id===id})||null}
  function latestProductionManifest(){
    return state.manifests.filter(function(manifest){return manifest.lane==='PRODUCTION'&&manifest.status==='PRODUCTION_DEPLOYED'}).sort(function(left,right){return Number(right.created_at)-Number(left.created_at)})[0]||null
  }
  function headPair(label,frontendSha,backendSha,manifestId){
    return '<article class="head-card"><h3>'+esc(label)+'</h3>'+
      '<div class="head-pair"><span class="muted">Frontend</span><span class="sha">'+esc(frontendSha||'Not recorded')+'</span></div>'+
      '<div class="head-pair"><span class="muted">Backend</span><span class="sha">'+esc(backendSha||'Not recorded')+'</span></div>'+
      (manifestId?'<div class="muted small">Manifest <span class="sha">'+esc(manifestId)+'</span></div>':'')+
      '</article>'
  }
  function renderHeads(lane){
    var staging=state.controls&&state.controls.staging_state||{},current,validated;
    if(lane==='STAGING'){
      current=manifestById(staging.current_manifest_id);
      validated=manifestById(staging.last_validated_manifest_id);
      byId('staging-heads').innerHTML=
        headPair(staging.status==='DETACHED_MANUAL_OWNERSHIP'?'Currently deployed (detached; physical bytes unknown)':'Currently deployed',current&&current.frontend_sha||staging.frontend_sha,current&&current.backend_sha||staging.backend_sha,staging.current_manifest_id)+
        headPair('Last successfully validated',validated&&validated.frontend_sha||staging.last_validated_frontend_sha,validated&&validated.backend_sha||staging.last_validated_backend_sha,staging.last_validated_manifest_id)
    }else{
      current=latestProductionManifest();
      validated=current;
      byId('production-heads').innerHTML=
        headPair('Currently deployed',current&&current.frontend_sha,current&&current.backend_sha,current&&current.id)+
        headPair('Last successfully validated (production E2E)',validated&&validated.frontend_sha,validated&&validated.backend_sha,validated&&validated.id)
    }
  }
  function laneHeader(lane){
    var item=state.lanes[lane]||{status:'OFF',changeable:false,reason:'Lane state is unavailable'},turningOff=item.status==='ON';
    var action=state.operator?'<div class="field"><label for="'+lane.toLowerCase()+'-reason">Reason for lane change</label><div class="actions"><input id="'+lane.toLowerCase()+'-reason" maxlength="1000" placeholder="Required before changing the lane"><button class="'+(turningOff?'danger ':'')+'compact" data-lane-control="'+(turningOff?'pause':'resume')+'" data-scope="'+esc(lane)+'" '+(item.changeable?'':'disabled title="Internal emergency stop is active"')+'>'+(turningOff?'Turn off':'Turn on')+'</button></div></div>':'';
    return '<div class="row"><div><div class="lane-title"><h2 id="'+lane.toLowerCase()+'-heading">'+esc(laneLabel(lane))+'</h2>'+badge(item.status,item.status==='ON'?'on':'off')+'</div><p class="muted">Latest state change reason: '+esc(item.reason||'None recorded')+'</p></div>'+action+'</div>'
  }
  function bindLaneControls(){
    Array.prototype.forEach.call(document.querySelectorAll('[data-lane-control]'),function(button){
      button.onclick=async function(){
        var lane=button.dataset.scope,input=byId(lane.toLowerCase()+'-reason'),message=byId(lane.toLowerCase()+'-control-status');
        try{
          var reason=input.value.trim();
          if(reason.length<3)throw new Error('Enter a reason for the lane change.');
          await request('/deploy/release-bus-v2/'+button.dataset.laneControl,{method:'POST',body:JSON.stringify({scope:lane,reason:reason})});
          status(message,laneLabel(lane)+' automation updated.',false);
          await refresh()
        }catch(error){status(message,error.message,true)}
      }
    })
  }
  async function renderLane(lane){
    byId(lane.toLowerCase()+'-header').innerHTML=laneHeader(lane);
    renderHeads(lane);
    var current=activeTrain(lane),currentNode=byId(lane.toLowerCase()+'-current'),nextNode=byId(lane.toLowerCase()+'-next'),previousNode=byId(lane.toLowerCase()+'-previous');
    currentNode.innerHTML='<h3>Current train</h3>'+(current?empty('Loading current train details…'):empty('No active '+laneLabel(lane).toLowerCase()+' train.'));
    if(current){
      var currentResult=await trainDetailSlot(current.id),currentLabel='Current '+laneLabel(lane).toLowerCase()+' train';
      currentNode.innerHTML='<h3>Current train</h3>'+(currentResult.detail?trainCard(currentResult.detail,{label:currentLabel}):trainDetailError(currentLabel,currentResult.error))
    }
    var queued=queuedCandidates(lane);
    nextNode.innerHTML='<h3>Next train if nothing changes</h3>'+(queued.length?projectedTrainCard(lane,queued,queueBlocker(lane,queued)):empty('Nothing is currently queued for the next '+laneLabel(lane).toLowerCase()+' train.'));
    var previous=laneTrains(lane).filter(function(train){return terminal.includes(train.status)});
    var visible=previous.slice(0,state.previousVisible[lane]);
    var details=await Promise.all(visible.map(function(train){return trainDetailSlot(train.id)}));
    previousNode.innerHTML='<h3>Previous trains</h3>'+(details.length?'<div class="train-list">'+details.map(function(result,index){var label='Previous train '+(index+1);return result.detail?trainCard(result.detail,{label:label}):trainDetailError(label,result.error)}).join('')+'</div>':empty('No previous '+laneLabel(lane).toLowerCase()+' trains recorded.'))+(previous.length>visible.length?'<div class="actions"><button class="compact" data-load-trains="'+esc(lane)+'">Load 5 more</button></div>':'');
    var loadButton=previousNode.querySelector('[data-load-trains]');
    if(loadButton)loadButton.onclick=function(){state.previousVisible[lane]+=5;renderLane(lane).catch(function(error){status(byId('dashboard-status'),error.message,true)})};
    bindLaneControls()
  }
  function filteredCandidates(){
    var number=Number(byId('pr-filter').value)||null,statusValue=byId('status-filter').value;
    return state.candidates.filter(function(candidate){return(!number||candidate.pr_number===number)&&(!statusValue||candidate.status===statusValue)}).sort(function(left,right){return Number(right.updated_at)-Number(left.updated_at)})
  }
  function bindCandidateActions(){
    Array.prototype.forEach.call(document.querySelectorAll('[data-revoke]'),function(button){button.onclick=function(){candidateAction('/deploy/release-bus-v2/candidates/'+encodeURIComponent(button.dataset.revoke)+'/revoke-production-readiness',{expected_row_version:Number(button.dataset.version)})}});
    Array.prototype.forEach.call(document.querySelectorAll('[data-cancel]'),function(button){button.onclick=function(){candidateAction('/deploy/release-bus-v2/candidates/'+encodeURIComponent(button.dataset.cancel)+'/cancel',{expected_row_version:Number(button.dataset.version)})}})
  }
  async function candidateAction(url,body){
    try{await request(url,{method:'POST',body:JSON.stringify(body)});await refresh()}catch(error){status(byId('production-selection-status'),error.message,true)}
  }
  function renderPullRequests(){
    var filtered=filteredCandidates(),visible=filtered.slice(0,state.prVisible);
    byId('pull-requests').innerHTML=visible.length?visible.map(function(item){return candidateCard(item,{actions:true})}).join(''):empty('No registered PRs match these filters.');
    byId('pull-request-count').textContent='Showing '+visible.length+' of '+filtered.length+' matching PRs';
    byId('load-more-prs').classList.toggle('hidden',visible.length>=filtered.length);
    bindCandidateActions()
  }
  function populateStatusFilter(){
    var select=byId('status-filter'),selected=select.value;
    select.innerHTML='<option value="">All statuses</option>'+candidateStatuses.map(function(value){return '<option value="'+esc(value)+'">'+esc(value)+'</option>'}).join('');
    select.value=selected
  }
  function parseDependencies(){
    return byId('dependencies').value.split(/\n/).map(function(value){return value.trim()}).filter(Boolean).map(function(line){
      var parts=line.split(':');
      if(parts.length!==2)throw new Error('Dependency must be candidate-uuid:ENVIRONMENT');
      return{candidate_id:parts[0],environment:parts[1].toUpperCase()}
    })
  }
  function parsePlan(){
    if(byId('repository').value!=='backend')return null;
    var units=byId('units').value.split(/\n|,/).map(function(value){return value.trim()}).filter(Boolean);
    if(!units.length)throw new Error('At least one backend deploy unit is required');
    var edges=byId('edges').value.split(/\n/).map(function(value){return value.trim()}).filter(Boolean).map(function(line){
      var values=line.split(/\s*->\s*/);
      if(values.length!==2)throw new Error('DAG edge must use A -> B');
      return values
    });
    return{units:units,edges:edges}
  }
  async function refresh(){
    if(state.refreshing)return;
    state.refreshing=true;
    byId('dashboard').setAttribute('aria-busy','true');
    try{
      var all=await Promise.all([
        request('/deploy/release-bus-v2/candidates?limit=500'),
        request('/deploy/release-bus-v2/trains'),
        request('/deploy/release-bus-v2/manifests'),
        request('/deploy/release-bus-v2/controls')
      ]);
      state.candidates=all[0].candidates||[];
      state.candidateById=Object.fromEntries(state.candidates.map(function(candidate){return[candidate.id,candidate]}));
      state.trains=all[1].trains||[];
      state.manifests=all[2].manifests||[];
      state.controls=all[3];
      state.trainDetails={};
      state.lanes={};
      (all[3].lanes||[]).forEach(function(lane){state.lanes[lane.lane]=lane});
      populateStatusFilter();
      await Promise.all([renderLane('STAGING'),renderLane('PRODUCTION')]);
      renderPullRequests();
      var stagingOn=state.lanes.STAGING&&state.lanes.STAGING.status==='ON',register=byId('register');
      if(register)register.disabled=!stagingOn;
      status(byId('dashboard-status'),'Release Bus state updated '+dateTime(Date.now())+'.',false)
    }finally{
      state.refreshing=false;
      byId('dashboard').setAttribute('aria-busy','false')
    }
  }
  function showAuthenticationForm(){byId('auth-form').classList.remove('hidden');byId('show-auth').classList.add('hidden');byId('token').focus()}
  function showDisconnected(message,error){byId('auth-connected').classList.add('hidden');byId('show-auth').classList.remove('hidden');setOperator(false);status(byId('auth-status'),message||'',error)}
  function showConnected(login){byId('auth-identity').textContent='Authenticated as '+login;byId('auth-connected').classList.remove('hidden');byId('show-auth').classList.add('hidden');byId('auth-form').classList.add('hidden');setOperator(true);status(byId('auth-status'),'',false)}
  async function connect(){
    state.token=(byId('token').value||state.token).trim();
    if(!state.token){showAuthenticationForm();status(byId('auth-status'),'Paste a token first.',true);return}
    try{
      var session=await request('/deploy/ui/session');
      localStorage.setItem(key,state.token);
      byId('token').value='';
      showConnected(session.login);
      await refresh()
    }catch(error){
      localStorage.removeItem(key);
      state.token='';
      showDisconnected(error.message,true);
      showAuthenticationForm()
    }
  }
  byId('show-auth').onclick=showAuthenticationForm;
  byId('connect').onclick=connect;
  byId('forget').onclick=function(){
    localStorage.removeItem(key);
    state.token='';
    byId('token').value='';
    byId('auth-form').classList.add('hidden');
    showDisconnected('',false);
    refresh().catch(function(error){status(byId('dashboard-status'),error.message,true)})
  };
  byId('pr-filter').oninput=function(){state.prVisible=10;renderPullRequests()};
  byId('status-filter').onchange=function(){state.prVisible=10;renderPullRequests()};
  byId('load-more-prs').onclick=function(){state.prVisible+=10;renderPullRequests()};
  byId('repository').onchange=function(){byId('backend-plan').classList.toggle('hidden',byId('repository').value!=='backend')};
  byId('mark-selection').onclick=async function(){
    var selected=Array.prototype.map.call(document.querySelectorAll('[data-select-production]:checked'),function(input){return{candidate_id:input.dataset.selectProduction,expected_head_sha:input.dataset.sha,expected_row_version:Number(input.dataset.version)}});
    if(!selected.length){status(byId('production-selection-status'),'Select at least one staging-validated PR.',true);return}
    try{
      var result=await request('/deploy/release-bus-v2/production-selections',{method:'POST',body:JSON.stringify({candidates:selected})});
      status(byId('production-selection-status'),'Production selection '+result.production_selection_id+' recorded.',false);
      await refresh()
    }catch(error){status(byId('production-selection-status'),error.message,true)}
  };
  byId('resolve').onclick=async function(){
    try{
      var repository=byId('repository').value,branch=byId('branch').value.trim();
      if(!branch)throw new Error('Enter a branch first.');
      var data=await request('/deploy/ui/branch-head?repository='+encodeURIComponent(repository)+'&branch='+encodeURIComponent(branch));
      byId('sha').value=data.head_sha;
      status(byId('register-status'),'Resolved '+data.head_sha,false)
    }catch(error){status(byId('register-status'),error.message,true)}
  };
  byId('register-form').onsubmit=async function(event){
    event.preventDefault();
    try{
      var body={repository:byId('repository').value,pr_number:Number(byId('pr-number').value),branch_name:byId('branch').value.trim(),expected_head_sha:byId('sha').value.trim().toLowerCase(),deploy_plan:parsePlan(),dependencies:parseDependencies()};
      var data=await request('/deploy/release-bus-v2/candidates',{method:'POST',body:JSON.stringify(body)});
      status(byId('register-status'),'Queued exact '+data.candidate.head_sha+' for staging.',false);
      event.target.reset();
      byId('backend-plan').classList.add('hidden');
      await refresh()
    }catch(error){status(byId('register-status'),error.message,true)}
  };
  setOperator(false);
  if(state.token){connect()}else{showDisconnected('',false);refresh().catch(function(error){status(byId('dashboard-status'),error.message,true)})}
  function interactionActive(){
    var active=document.activeElement;
    return Boolean(document.querySelector('details[open]'))||Boolean(active&&['INPUT','SELECT','TEXTAREA'].includes(active.tagName))
  }
  setInterval(function(){if(!interactionActive())refresh().catch(function(error){status(byId('dashboard-status'),error.message,true)})},30000)
})();`;
}
