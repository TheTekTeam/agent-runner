import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SourceActivationRefusal, activateAgentRunnerSource, parseActivationArgs, validateTargetSha } from './agent-runner-source-activation.mjs';

const OLD = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

function rig({ oldHead=OLD, fetched=TARGET, branch='main', dirty=false, ancestor=0, fetchStatus=0, repo='/repo', lockError=null }={}) {
  let head=oldHead, lock=false, merges=0, fetches=0;
  const calls=[], evidence=[];
  const runGit=(args)=>{
    calls.push(args); const k=args.join(' ');
    if(k==='rev-parse --show-toplevel') return {status:0,stdout:`${repo}\n`};
    if(k==='symbolic-ref --quiet --short HEAD') return {status:0,stdout:`${branch}\n`};
    if(k==='status --porcelain=v1 --untracked-files=all') return {status:0,stdout:dirty?'?? x\n':''};
    if(k==='rev-parse --verify HEAD^{commit}') return {status:0,stdout:`${head}\n`};
    if(k==='remote get-url origin') return {status:0,stdout:'git@github.com:TheTekTeam/agent-runner.git\n'};
    if(k==='fetch --no-tags origin refs/heads/main:refs/remotes/origin/main'){fetches++;return {status:fetchStatus,stdout:''};}
    if(k==='rev-parse --verify refs/remotes/origin/main^{commit}') return {status:0,stdout:`${fetched}\n`};
    if(k===`merge-base --is-ancestor ${head} ${TARGET}`) return {status:ancestor,stdout:''};
    if(k===`merge --ff-only --no-edit ${TARGET}`){merges++;head=TARGET;return {status:0,stdout:''};}
    throw new Error(`unexpected git: ${k}`);
  };
  const acquireLock=()=>{if(lockError)throw lockError;lock=true;return()=>{lock=false;};};
  const options={target:TARGET,env:{HOME:'/home/gp',AGENT_RUNNER_HOME:'/repo',AGENT_RUNNER_IMPLEMENTATION_LOCK:'/state/lock'},repositoryRoot:'/repo',runGit,acquireLock,realpath:v=>v,getuid:()=>1000,now:()=> '2026-08-17T21:00:00.000Z',writeEvidence:r=>{evidence.push(structuredClone(r));return '/secret/evidence.json';},exists:()=>lock,readFile:()=>{if(!lock){const e=new Error('missing');e.code='ENOENT';throw e;}return '123\n2026-08-17T21:00:00.000Z\n';}};
  return {options,calls,evidence,get head(){return head;},get merges(){return merges;},get fetches(){return fetches;}};
}

async function reason(r, expected){await assert.rejects(()=>activateAgentRunnerSource(r.options),e=>{assert.equal(e.reason,expected);return true;});}

test('CLI accepts only one exact full SHA target',()=>{
  assert.equal(validateTargetSha(TARGET.toUpperCase()),TARGET);
  assert.deepEqual(parseActivationArgs(['--target',TARGET]),{help:false,target:TARGET});
  assert.throws(()=>validateTargetSha('b'.repeat(12)),/40-character/);
  assert.throws(()=>parseActivationArgs(['--target',TARGET,'--remote','evil']),e=>e instanceof SourceActivationRefusal&&e.reason==='unsupported-argument');
  assert.throws(()=>parseActivationArgs(['--repo','/tmp/x','--target',TARGET]),/Unsupported/);
});

test('clean ancestor fast-forwards exact fetched target under the lock',async()=>{
  const r=rig(); const out=await activateAgentRunnerSource(r.options);
  assert.equal(out.result,'activated'); assert.equal(r.head,TARGET); assert.equal(r.merges,1); assert.equal(r.fetches,1);
  assert.equal(r.evidence.at(-1).lockAcquired,true); assert.equal(r.evidence.at(-1).lockReleased,true);
});

test('already-active stays idempotent but still fetches/verifies',async()=>{
  const r=rig({oldHead:TARGET}); const out=await activateAgentRunnerSource(r.options);
  assert.equal(out.result,'already-active'); assert.equal(r.merges,0); assert.equal(r.fetches,1);
});

test('wrong branch, dirty tree, target mismatch and divergence refuse without merge',async()=>{
  for(const [opts,want] of [[{branch:'feature'},'wrong-branch'],[{dirty:true},'dirty-checkout'],[{fetched:OTHER},'target-origin-mismatch'],[{ancestor:1},'non-fast-forward-target']]){
    const r=rig(opts); await reason(r,want); assert.equal(r.merges,0); assert.equal(r.head,OLD);
  }
});

test('fetch and merge-base failures fail closed',async()=>{
  const f=rig({fetchStatus:1}); await reason(f,'origin-fetch-failed'); assert.equal(f.merges,0);
  const m=rig({ancestor:2}); await reason(m,'merge-base-failed'); assert.equal(m.merges,0);
});

test('lock, canonical identity, AGENT_RUNNER_HOME, root and short SHA refuse before mutation',async()=>{
  const le=new Error('held');le.code='AGENT_RUNNER_LOCKED'; const l=rig({lockError:le});
  await assert.rejects(()=>activateAgentRunnerSource(l.options),e=>e.code==='AGENT_RUNNER_LOCKED'); assert.equal(l.calls.length,0);
  const c=rig({repo:'/other'}); await reason(c,'canonical-repository-mismatch'); assert.equal(c.merges,0);
  const h=rig();h.options.env.AGENT_RUNNER_HOME='/other';await reason(h,'configured-agent-runner-home-mismatch');assert.equal(h.calls.length,0);
  const root=rig();root.options.getuid=()=>0;await reason(root,'root-execution-forbidden');assert.equal(root.calls.length,0);
  const short=rig();short.options.target='a'.repeat(12);await reason(short,'invalid-target-sha');assert.equal(short.calls.length,0);
});

test('real evidence is 0600, bounded, and malformed stale lock is preserved',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'ar232-'));
  try{
    const r=rig();r.options.env={HOME:temp,AGENT_RUNNER_HOME:'/repo',AGENT_RUNNER_IMPLEMENTATION_LOCK:join(temp,'lock'),AGENT_RUNNER_SOURCE_ACTIVATION_EVIDENCE_DIR:join(temp,'evidence')};
    delete r.options.acquireLock;delete r.options.writeEvidence;delete r.options.exists;delete r.options.readFile;
    await activateAgentRunnerSource(r.options);
    const p=join(temp,'evidence',readdirSync(join(temp,'evidence'))[0]); assert.equal(statSync(p).mode&0o777,0o600);
    const s=readFileSync(p,'utf8'); assert.doesNotMatch(s,/github\.com|\/home\/gp|\/repo|AGENT_RUNNER|prompt|stdout|stderr/i);
    const bad=rig();bad.options.env={HOME:temp,AGENT_RUNNER_HOME:'/repo',AGENT_RUNNER_IMPLEMENTATION_LOCK:join(temp,'bad.lock'),AGENT_RUNNER_SOURCE_ACTIVATION_EVIDENCE_DIR:join(temp,'bad-evidence')};
    writeFileSync(bad.options.env.AGENT_RUNNER_IMPLEMENTATION_LOCK,'corrupt lock data\n');delete bad.options.acquireLock;delete bad.options.writeEvidence;delete bad.options.exists;delete bad.options.readFile;
    await assert.rejects(()=>activateAgentRunnerSource(bad.options),e=>e.code==='AGENT_RUNNER_LOCKED');
    assert.equal(readFileSync(bad.options.env.AGENT_RUNNER_IMPLEMENTATION_LOCK,'utf8'),'corrupt lock data\n'); assert.equal(bad.calls.length,0);
  }finally{rmSync(temp,{recursive:true,force:true});}
});
