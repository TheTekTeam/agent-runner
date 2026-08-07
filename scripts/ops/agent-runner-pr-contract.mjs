import { createHash } from 'node:crypto';
import { LOCAL_EXECUTOR_RISK_CLASSES } from './agent-runner-local-executor-policy.mjs';

export const PR_CONTRACT_SCHEMA_VERSION = 1;
export const PR_FAILURE_CODES = Object.freeze(['invalid-request','project-not-enabled','repository-mismatch','manager-authority-missing','manager-authority-stale','validation-evidence-missing','validation-evidence-failed','validation-evidence-expired','source-head-changed','target-branch-changed','conflicting-existing-pr','duplicate-open-prs','partial-github-read','github-write-rejected','interrupted-transaction-requires-adoption','unsupported-risk-class','manual-review-required','concurrent-transaction-active','idempotency-key-collision']);
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, SHA=/^[a-f0-9]{40,64}$/i, TOKEN=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/, BRANCH=/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
export class PrContractError extends Error { constructor(code, message) { super(message); this.name='PrContractError'; this.code=PR_FAILURE_CODES.includes(code)?code:'invalid-request'; } }
const fail=(code,message)=>{ throw new PrContractError(code,message); };
const text=(v,n,max=2000)=>{ if(typeof v!=='string'||!v.trim()||Buffer.byteLength(v)>max||/[\x00-\x1f\x7f]/.test(v)||v.includes('```')) fail('invalid-request',`${n} is invalid`); return v.trim(); };
const token=(v,n)=>TOKEN.test(v||'')?v:fail('invalid-request',`${n} is invalid`);
const sha=(v,n)=>SHA.test(v||'')?v.toLowerCase():fail('invalid-request',`${n} is invalid`);
const branch=(v,n)=>BRANCH.test(v||'')&&!v.includes('..')&&!v.includes('//')&&!v.endsWith('/')&&!v.endsWith('.lock')&&!v.includes('@{')?v:fail('invalid-request',`${n} is invalid`);
const stable=(v)=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const digest=(v)=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
export function normalizePrPublicationRequest(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)) fail('invalid-request','request must be an object');
  const projectId=token(input.projectId,'projectId'); const repository=REPO.test(input.repository||'')?input.repository:fail('invalid-request','repository is invalid');
  const issueNumber=Number.isInteger(input.issueNumber)&&input.issueNumber>0?input.issueNumber:fail('invalid-request','issueNumber is invalid');
  const sourceBranch=branch(input.sourceBranch,'sourceBranch'), targetBranch=branch(input.targetBranch,'targetBranch'); if(sourceBranch===targetBranch) fail('invalid-request','source and target branches must differ');
  const expectedHeadSha=sha(input.expectedHeadSha,'expectedHeadSha'), managerRevision=text(input.managerRevision,'managerRevision',200), managerFingerprint=/^sha256:[a-f0-9]{64}$/.test(input.managerFingerprint||'')?input.managerFingerprint:fail('invalid-request','managerFingerprint is invalid');
  const executorJobId=token(input.executorJobId,'executorJobId'), implementationAttemptId=token(input.implementationAttemptId||input.executorJobId,'implementationAttemptId'), requestId=token(input.requestId,'requestId');
  if(!LOCAL_EXECUTOR_RISK_CLASSES.includes(input.riskClass)) fail('unsupported-risk-class','riskClass is unsupported');
  if(!Array.isArray(input.requiredValidationProfiles)||!input.requiredValidationProfiles.length||input.requiredValidationProfiles.length>8) fail('invalid-request','requiredValidationProfiles is invalid');
  const seen=new Set(); const requiredValidationProfiles=Object.freeze(input.requiredValidationProfiles.map(x=>{ const profile=text(x?.profile,'validation profile',64); if(!/^[a-z][a-z0-9._-]{0,63}$/.test(profile)||seen.has(profile)) fail('invalid-request','validation profiles are invalid'); seen.add(profile); return Object.freeze({profile,validationId:token(x.validationId,'validationId')}); }).sort((a,b)=>a.profile.localeCompare(b.profile)));
  const filesChanged=Object.freeze([...new Set((input.filesChanged||[]).map(x=>{x=text(x,'changed file',500); if(x.startsWith('/')||x.includes('..')||x.includes('\\')) fail('invalid-request','changed file is invalid'); return x;}))].sort());
  const knownLimitations=Object.freeze((input.knownLimitations||[]).map(x=>text(x,'known limitation',500))); if(filesChanged.length>200||knownLimitations.length>20) fail('invalid-request','request list exceeds bounds');
  const identity={schemaVersion:1,projectId,repository,issueNumber,sourceBranch,targetBranch,expectedHeadSha,managerRevision,managerFingerprint,executorJobId,riskClass:input.riskClass,requiredValidationProfiles}; const idempotencyKey=`pr-publication:${digest(identity)}`;
  return Object.freeze({schemaVersion:1,projectId,repository,issueNumber,sourceBranch,targetBranch,expectedHeadSha,managerRevision,managerFingerprint,executorJobId,implementationAttemptId,requestId,riskClass:input.riskClass,requiredValidationProfiles,approvedScope:text(input.approvedScope,'approvedScope',2000),filesChanged,knownLimitations,idempotencyKey,transactionId:`pr-tx-${digest({idempotencyKey,requestId}).slice(0,48)}`});
}
export function buildPullRequestBody({repository,issueNumber,sourceBranch,expectedHeadSha,approvedScope,filesChanged=[],validationEvidence,knownLimitations=[]}) {
  if(!REPO.test(repository||'')||!Number.isInteger(issueNumber)||!branch(sourceBranch,'sourceBranch')||!sha(expectedHeadSha,'expectedHeadSha')||!Array.isArray(validationEvidence)||!validationEvidence.length) fail('invalid-request','PR body inputs are invalid');
  const safe=[approvedScope,...filesChanged,...knownLimitations,...validationEvidence.flatMap(x=>[x.profile,x.validationId,x.state,x.expiresAt])]; if(safe.some(x=>typeof x!=='string'||x.includes('```')||/[\x00-\x1f\x7f]/.test(x))) fail('invalid-request','PR body field is invalid');
  const list=(items,empty)=>items.length?items.map(x=>`- ${x}`).join('\n'):`- ${empty}`;
  const body=['## Linked issue',`Linked issue: ${repository}#${issueNumber}`,'','## Approved scope',approvedScope,'','## Exact head SHA',`\`${expectedHeadSha}\` on \`${sourceBranch}\` `,'','## Files changed',list(filesChanged,'no files reported'),'','## Validation evidence',validationEvidence.map(x=>`- \`${x.profile}\`: ${x.state} (validation \`${x.validationId}\`, evidence expires ${x.expiresAt})`).join('\n'),'','## Known limitations',list(knownLimitations,'none reported'),'','## Merge authority','This pull request does not grant merge, approval, issue-closure or branch-deletion authority.'].join('\n');
  if(Buffer.byteLength(body)>32*1024) fail('invalid-request','generated PR body exceeds bound'); return body;
}
export const mapValidationFreshnessFailure=(reason)=>reason==='validation-expired'?'validation-evidence-expired':'validation-evidence-failed';
