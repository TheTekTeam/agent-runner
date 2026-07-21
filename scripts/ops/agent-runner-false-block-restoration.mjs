import { execFileSync } from 'node:child_process';

import { inspectQueueDrainIncident } from './agent-runner-queue-drain-classifier.mjs';
import { findLinkedOpenPullRequests } from './claude-runner-review-followup.mjs';

const STATUS_BLOCKED = 'status:blocked';
const STATUS_READY = 'status:ready';
const DEPENDENCY_LINE = /^\s*(?:[-*]\s*)?(?:blocked by|depends on|dependency|waiting for)\s*:/im;

function defaultGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function labelsOf(issue = {}) {
  return (issue.labels || []).map((label) => String(label?.name || label || '').trim()).filter(Boolean);
}

function readIssue(repo, issueNumber, ghRunner = defaultGh) {
  return JSON.parse(ghRunner([
    'issue', 'view', String(issueNumber), '--repo', repo,
    '--json', 'number,state,title,body,url,labels',
  ]) || '{}');
}

function listOpenPullRequests(repo, ghRunner = defaultGh) {
  return JSON.parse(ghRunner([
    'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100',
    '--json', 'number,title,body,url,headRefName',
  ]) || '[]').map((pullRequest) => ({ ...pullRequest, state: 'open' }));
}

export function evaluateFalseBlockRestoration({ classification, issue, linkedOpenPullRequests = [] } = {}) {
  if (!classification?.restorableCandidate || classification.classification !== 'machine_profile_false_block') {
    return { restorable: false, reason: 'incident-classification-not-restorable', safeNextAction: 'Leave the issue unchanged.' };
  }
  if (!issue || Number(issue.number) !== Number(classification.issueNumber)) {
    return { restorable: false, reason: 'issue-identity-mismatch', safeNextAction: 'Inspect the incident and live issue identity.' };
  }
  if (String(issue.state || '').toUpperCase() !== 'OPEN') {
    return { restorable: false, reason: 'issue-not-open', safeNextAction: 'Leave closed issues unchanged.' };
  }
  const labels = labelsOf(issue);
  const statusLabels = labels.filter((label) => label.startsWith('status:'));
  const agentLabels = labels.filter((label) => label.startsWith('agent:'));
  if (statusLabels.length !== 1 || statusLabels[0] !== STATUS_BLOCKED) {
    return { restorable: false, reason: 'current-status-not-uniquely-blocked', safeNextAction: 'Resolve current status-label ambiguity manually.' };
  }
  if (agentLabels.length !== 1) {
    return { restorable: false, reason: 'agent-label-not-unique', safeNextAction: 'Resolve execution ownership before restoration.' };
  }
  if (DEPENDENCY_LINE.test(String(issue.body || ''))) {
    return { restorable: false, reason: 'explicit-dependency-marker-present', safeNextAction: 'Verify the real dependency before changing status.' };
  }
  if (linkedOpenPullRequests.length > 0) {
    return { restorable: false, reason: 'linked-open-pull-request', safeNextAction: 'Resolve or review the linked pull request before restoration.' };
  }
  return {
    restorable: true,
    reason: 'proven-machine-profile-false-block',
    fromStatus: STATUS_BLOCKED,
    toStatus: STATUS_READY,
    safeNextAction: 'Restore status:ready without changing any other label or issue content.',
  };
}

export function buildFalseBlockRestorationPlan(store, {
  repo,
  startAt = '2026-07-20T00:00:00.000Z',
  endAt = '2026-07-21T00:00:00.000Z',
  ghRunner = defaultGh,
} = {}) {
  const incident = inspectQueueDrainIncident(store, { repo, startAt, endAt });
  const openPullRequests = listOpenPullRequests(repo, ghRunner);
  const candidatesByIssue = new Map();
  for (const classification of incident.classifications) {
    if (!classification.restorableCandidate) continue;
    const existing = candidatesByIssue.get(classification.issueNumber);
    if (!existing || String(classification.incidentRecordId) < String(existing.incidentRecordId)) {
      candidatesByIssue.set(classification.issueNumber, classification);
    }
  }

  const proposals = [...candidatesByIssue.values()].sort((left, right) => left.issueNumber - right.issueNumber).map((classification) => {
    let issue;
    try {
      issue = readIssue(repo, classification.issueNumber, ghRunner);
    } catch (error) {
      return {
        issueNumber: classification.issueNumber,
        incidentRecordId: classification.incidentRecordId,
        restorable: false,
        reason: 'live-issue-read-failed',
        safeNextAction: 'Restore GitHub read access and rerun the deterministic proposal.',
      };
    }
    const linkedOpenPullRequests = findLinkedOpenPullRequests({
      issueNumber: classification.issueNumber,
      pullRequests: openPullRequests,
    });
    return {
      issueNumber: classification.issueNumber,
      incidentRecordId: classification.incidentRecordId,
      ...evaluateFalseBlockRestoration({ classification, issue, linkedOpenPullRequests }),
      linkedOpenPullRequestNumbers: linkedOpenPullRequests.map((pullRequest) => pullRequest.number),
    };
  });

  return {
    incident,
    proposals,
    restorable: proposals.filter((proposal) => proposal.restorable).length,
    withheld: proposals.filter((proposal) => !proposal.restorable).length,
  };
}

export function applyFalseBlockRestorationPlan(store, plan, {
  repo,
  ghRunner = defaultGh,
  now = () => new Date().toISOString(),
} = {}) {
  const results = [];
  for (const proposal of plan.proposals) {
    if (!proposal.restorable) {
      results.push({ ...proposal, applied: false });
      continue;
    }
    try {
      ghRunner([
        'issue', 'edit', String(proposal.issueNumber), '--repo', repo,
        '--remove-label', STATUS_BLOCKED, '--add-label', STATUS_READY,
      ]);
      const verified = readIssue(repo, proposal.issueNumber, ghRunner);
      const statusLabels = labelsOf(verified).filter((label) => label.startsWith('status:'));
      if (String(verified.state || '').toUpperCase() !== 'OPEN' || statusLabels.length !== 1 || statusLabels[0] !== STATUS_READY) {
        results.push({ ...proposal, applied: false, reason: 'post-restoration-verification-failed' });
        continue;
      }
      const appliedAt = now();
      store.recordQueueEvent({
        repo,
        eventType: 'queue-drain-false-block-restored',
        issueNumber: proposal.issueNumber,
        statusLabel: STATUS_READY,
        reason: proposal.reason,
        createdAt: appliedAt,
        payload: {
          incidentRecordId: proposal.incidentRecordId,
          fromStatus: STATUS_BLOCKED,
          toStatus: STATUS_READY,
          issueMutation: true,
          otherLabelsPreserved: true,
        },
      });
      results.push({ ...proposal, applied: true, appliedAt });
    } catch (error) {
      results.push({ ...proposal, applied: false, reason: 'restoration-mutation-failed' });
    }
  }
  return {
    attempted: plan.proposals.filter((proposal) => proposal.restorable).length,
    applied: results.filter((result) => result.applied).length,
    withheld: results.filter((result) => !result.applied).length,
    results,
  };
}
