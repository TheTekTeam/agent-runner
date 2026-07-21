function labelNames(issue = {}) {
  return (issue.labels || [])
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .map((label) => String(label || '').trim().toLowerCase())
    .filter(Boolean);
}

function exactSingle(labels, prefix) {
  const matches = labels.filter((label) => label.startsWith(prefix));
  return {
    count: matches.length,
    value: matches.length === 1 ? matches[0] : null,
    matches,
  };
}

export function executionLabelAuthority(issue = {}) {
  const labels = labelNames(issue);
  const status = exactSingle(labels, 'status:');
  const agent = exactSingle(labels, 'agent:');

  if (status.count !== 1) {
    return {
      allowed: false,
      reason: status.count === 0 ? 'candidate-status-label-missing' : 'candidate-status-label-ambiguous',
      statusLabel: null,
      agentLabel: agent.value,
      evidence: { statusLabels: status.matches, agentLabels: agent.matches },
    };
  }
  if (agent.count !== 1) {
    return {
      allowed: false,
      reason: agent.count === 0 ? 'candidate-agent-label-missing' : 'candidate-agent-label-ambiguous',
      statusLabel: status.value,
      agentLabel: null,
      evidence: { statusLabels: status.matches, agentLabels: agent.matches },
    };
  }

  return {
    allowed: true,
    reason: 'candidate-label-authority-valid',
    statusLabel: status.value,
    agentLabel: agent.value,
    evidence: { statusLabels: status.matches, agentLabels: agent.matches },
  };
}
