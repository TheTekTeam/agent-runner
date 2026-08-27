// #401 FLEET.QUALIFICATION.PUBLICATION.1 — canonical repository-owned accepted
// qualification evidence.
//
// This is the single, static, bounded source of independently accepted
// per-instance qualification evidence consumed by the default fleet readiness
// CLI path. It contains ONLY the exact acceptance records for the two
// independently accepted Z790 results:
//
//   - Codex  #389  codex-cli@dev-cluster-z790        revision codex-z790-58e9d9edf45669ac
//   - Claude #398  claude-code-cli@dev-cluster-z790  revision claude-z790-7e13ce3be223baf8
//
// There is NO runtime GitHub/network lookup and NO machine-local
// credential/session/config dependency. Dell Claude and Dell Codex are
// deliberately absent so publication keeps them as explicit fail-closed
// evidence gaps rather than inventing a revision.
//
// Only fields the publication actually consumes are persisted here. Quota
// percentages, credentials/tokens, prompts, raw provider output, session ids,
// unrestricted environment and account credit/balance data are canary-only and
// are never carried into this repository-owned source.

export const FLEET_ACCEPTED_QUALIFICATION_EVIDENCE_REVISION =
  'fleet-accepted-qualification-evidence-v1';

const ACCEPTED_QUALIFICATION_RESULTS = Object.freeze([
  Object.freeze({
    accepted: true,
    qualified: true,
    nodeId: 'dev-cluster-z790',
    agentInstanceId: 'codex-cli@dev-cluster-z790',
    qualificationRevision: 'codex-z790-58e9d9edf45669ac',
    resultFingerprint:
      'sha256:58e9d9edf45669ac354bc400c4a7bf3ccd3b3e7bce92544f7eaba76895a43dbf',
    evidence: Object.freeze({
      codexVersion: '0.146.0',
      model: 'gpt-5.6-terra',
      profile: 'codex-canary-v1',
      effort: 'low',
      sandboxMode: 'workspace-write',
      approvalMode: 'never',
      networkAccess: false,
    }),
  }),
  Object.freeze({
    accepted: true,
    qualified: true,
    nodeId: 'dev-cluster-z790',
    agentInstanceId: 'claude-code-cli@dev-cluster-z790',
    qualificationRevision: 'claude-z790-7e13ce3be223baf8',
    resultFingerprint:
      'sha256:7e13ce3be223baf8967748ca5f48c96ea27fa945f3239124360f5c1395026efe',
    evidence: Object.freeze({
      claudeVersion: '2.1.231',
      providerClass: 'first-party',
      model: 'sonnet',
      profile: 'narrow',
      effort: 'low',
      permissionMode: 'dontAsk',
      toolPolicyFingerprint:
        'sha256:89af61db282d331f5d198f6a6642718e1bbb3c5ab8254a6e6acc367843af4403',
    }),
  }),
]);

export function canonicalAcceptedQualificationResults() {
  return ACCEPTED_QUALIFICATION_RESULTS.map((result) => ({
    ...result,
    evidence: { ...result.evidence },
  }));
}
