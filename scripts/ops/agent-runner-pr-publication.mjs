import { spawnSync } from 'node:child_process';
import { evaluateValidationFreshness } from './agent-runner-validation-profile-contract.mjs';
import { buildPullRequestBody, mapValidationFreshnessFailure, PrContractError } from './agent-runner-pr-contract.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value) ? value.toLowerCase() : null;
const repository = value => typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : null;
const pr = value => value && Number.isInteger(value.number) && value.number > 0 && value.draft === true && typeof value.state === 'string' && value.head && value.base && sha(value.head.sha) && typeof value.head.ref === 'string' && typeof value.base.ref === 'string' && typeof value.body==='string' ? Object.freeze({number:value.number,draft:true,state:value.state,headSha:value.head.sha.toLowerCase(),headRef:value.head.ref,baseRef:value.base.ref,body:value.body,url:typeof value.html_url==='string'?value.html_url:null}) : null;
const fail = (code,message) => { throw new PrContractError(code,message); };

/** A deliberately tiny GitHub surface: GET observations plus POST/PATCH pulls only. */
export class GhCliPullRequestClient {
  constructor({spawn=spawnSync,env=process.env,timeoutMs=30_000,maxOutputBytes=1024*1024}={}) { this.spawn=spawn; this.env=Object.fromEntries(['PATH','HOME','XDG_CONFIG_HOME','GH_CONFIG_DIR','GH_HOST','GH_TOKEN','GITHUB_TOKEN','HTTPS_PROXY','HTTP_PROXY','NO_PROXY'].filter(k=>env[k]!=null).map(k=>[k,String(env[k]) ])); this.timeoutMs=timeoutMs; this.maxOutputBytes=maxOutputBytes; }
  request(method, endpoint, fields=null) {
    if(!['GET','POST','PATCH'].includes(method)||!endpoint.startsWith('/repos/')||!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/(?:issues\/\d+(?:\/comments)?|git\/ref\/heads\/.+|pulls)(?:\/\d+)?)?(?:\?.*)?$/.test(endpoint)) throw new Error('GitHub API endpoint is not allowlisted');
    const args=['api','--method',method,endpoint]; if(fields) for(const [key,value] of Object.entries(fields)) args.push('-f',`${key}=${value}`);
    const out=this.spawn('gh',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:this.env,timeout:this.timeoutMs,maxBuffer:this.maxOutputBytes});
    if(out.error?.code==='ETIMEDOUT') { const e=new Error('GitHub request timed out');e.code='provider-timeout';throw e; }
    if(out.status!==0) { const e=new Error('GitHub request failed');e.code='provider-request-failed';throw e; }
    try{return JSON.parse(out.stdout||'null')}catch{const e=new Error('GitHub response is malformed');e.code='provider-invalid-json';throw e;}
  }
}

export async function readPublicationEvidence({client,request}) {
  if(!client||typeof client.request!=='function') fail('partial-github-read','GitHub client is required'); const repo=repository(request.repository); if(!repo) fail('repository-mismatch','invalid repository');
  try {
    const [issue,head,base,pulls]=await Promise.all([client.request('GET',`/repos/${repo}/issues/${request.issueNumber}`),client.request('GET',`/repos/${repo}/git/ref/heads/${request.sourceBranch}`),client.request('GET',`/repos/${repo}/git/ref/heads/${request.targetBranch}`),client.request('GET',`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(request.sourceBranch)}&base=${encodeURIComponent(request.targetBranch)}`)]);
    const headSha=sha(head?.object?.sha),baseSha=sha(base?.object?.sha); if(!issue||issue.number!==request.issueNumber||issue.state!=='open'||!headSha||!baseSha||!Array.isArray(pulls)) fail('partial-github-read','GitHub read is incomplete');
    const pullsNormalized=pulls.map(pr); if(pullsNormalized.some(x=>!x)) fail('partial-github-read','GitHub PR read is malformed');
    return Object.freeze({issueNumber:issue.number,headSha,baseSha,pulls:Object.freeze(pullsNormalized)});
  } catch(error) { if(error instanceof PrContractError) throw error; fail('partial-github-read','GitHub read was ambiguous'); }
}

function compatible(existing, request) { return existing.draft && existing.state==='open' && existing.headSha===request.expectedHeadSha && existing.headRef===request.sourceBranch && existing.baseRef===request.targetBranch; }
function validateEvidence(request,evidenceStore,profileContracts,now) { const all=[]; for(const needed of request.requiredValidationProfiles){const evidence=evidenceStore?.get?.(needed.validationId);if(!evidence)fail('validation-evidence-missing','validation evidence is missing');const freshness=evaluateValidationFreshness(evidence,{projectId:request.projectId,profile:needed.profile,expectedSha:request.expectedHeadSha,currentProfileContractSha256:profileContracts?.[needed.profile],now});if(!freshness.fresh)fail(mapValidationFreshnessFailure(freshness.reason),'validation evidence is not fresh');all.push({profile:needed.profile,validationId:needed.validationId,state:evidence.state,expiresAt:evidence.expiresAt});}return all; }

export async function publishDraftPullRequest({request,store,client,evidenceStore,profileContracts,authorityCheck,now=new Date().toISOString()}={}) {
  if(!store||typeof store.beginTransaction!=='function') fail('invalid-request','transaction store is required'); if(typeof authorityCheck!=='function') fail('manager-authority-missing','authority check is required');
  const begun=store.beginTransaction(request,{now}); if(begun.transaction.state==='completed') return Object.freeze({...begun.transaction.result,replayed:true});
  try {
    const validationEvidence=validateEvidence(request,evidenceStore,profileContracts,now); const before=await readPublicationEvidence({client,request}); if(before.headSha!==request.expectedHeadSha)fail('source-head-changed','source branch head changed');
    if(!await authorityCheck(request)) fail('manager-authority-stale','manager authority is stale');
    if(before.pulls.length>1)fail('duplicate-open-prs','multiple open PRs exist'); let existing=before.pulls[0]||null;
    if(existing&&!compatible(existing,request))fail('conflicting-existing-pr','existing PR is incompatible');
    let published=existing,adopted=Boolean(existing); const body=buildPullRequestBody({...request,validationEvidence});
    if(!published) { const current=await readPublicationEvidence({client,request}); if(current.headSha!==request.expectedHeadSha)fail('source-head-changed','source branch head changed'); if(current.baseSha!==before.baseSha)fail('target-branch-changed','target branch changed'); if(!await authorityCheck(request))fail('manager-authority-stale','manager authority is stale'); const created=pr(client.request('POST',`/repos/${request.repository}/pulls`,{title:`#${request.issueNumber}: ${request.approvedScope.slice(0,120)}`,head:request.sourceBranch,base:request.targetBranch,body,draft:'true'})); if(!created)fail('github-write-rejected','GitHub did not create a valid draft PR'); published=created; store.recordGithubCreated(request.transactionId,{prNumber:published.number,before,intended:{headSha:request.expectedHeadSha,baseSha:before.baseSha,draft:true},now}); }
    if (published.body !== body) { const current=await readPublicationEvidence({client,request}); if(current.headSha!==request.expectedHeadSha||current.baseSha!==before.baseSha) fail('source-head-changed','branch changed before update'); if(!await authorityCheck(request))fail('manager-authority-stale','manager authority is stale'); const updated=pr(client.request('PATCH',`/repos/${request.repository}/pulls/${published.number}`,{body})); if(!updated||!compatible(updated,request)||updated.body!==body)fail('github-write-rejected','GitHub did not apply a bounded compatible update'); published=updated; }
    const after=await readPublicationEvidence({client,request}); const matched=after.pulls.filter(x=>x.number===published.number&&compatible(x,request)&&x.body===body); if(matched.length!==1)fail('github-write-rejected','GitHub write readback is not exact'); const result=Object.freeze({schemaVersion:1,transactionId:request.transactionId,prNumber:published.number,url:published.url,adopted,headSha:request.expectedHeadSha}); store.completeTransaction(request.transactionId,{result,readback:{headSha:after.headSha,baseSha:after.baseSha,prNumber:published.number},now}); return result;
  } catch(error) { const code=error instanceof PrContractError?error.code:'github-write-rejected'; store.failTransaction(request.transactionId,{errorCode:code,result:{reasonCode:code},now}); throw error; }
}
