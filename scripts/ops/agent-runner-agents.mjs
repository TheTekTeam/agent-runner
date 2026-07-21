const FUTURE_CONTROLS = {
  model: { supported: false },
  effort: { supported: false },
  maxBudgetUsd: { supported: false },
  permissionMode: { supported: false },
  resumeSession: { supported: false },
  outputFormat: { supported: false },
  tools: { supported: false },
  allowedTools: { supported: false },
  disallowedTools: { supported: false },
  worktree: { supported: false },
  strictMcpConfig: { supported: false },
  disableSlashCommands: { supported: false },
  settings: { supported: false },
  settingSources: { supported: false },
};

export const AGENT_ADAPTERS = Object.freeze({
  'claude-code-cli': Object.freeze({
    agentId: 'claude-code-cli',
    type: 'claude',
    command: 'claude',
    implemented: true,
    labels: Object.freeze(['agent:claude', 'agent:claude-code-cli']),
    controls: Object.freeze({
      model: Object.freeze({ supported: true, flag: '--model' }),
      effort: Object.freeze({ supported: true, flag: '--effort' }),
      maxBudgetUsd: Object.freeze({ supported: true, flag: '--max-budget-usd' }),
      permissionMode: Object.freeze({ supported: true, flag: '--permission-mode' }),
      resumeSession: Object.freeze({ supported: true, flag: '--resume' }),
      tools: Object.freeze({ supported: true, flag: '--tools' }),
      allowedTools: Object.freeze({ supported: true, flag: '--allowedTools' }),
      disallowedTools: Object.freeze({ supported: true, flag: '--disallowedTools' }),
      worktree: Object.freeze({ supported: true, flag: '--worktree' }),
      strictMcpConfig: Object.freeze({ supported: true, flag: '--strict-mcp-config' }),
      disableSlashCommands: Object.freeze({ supported: true, flag: '--disable-slash-commands' }),
      settings: Object.freeze({ supported: true, flag: '--settings' }),
      settingSources: Object.freeze({ supported: true, flag: '--setting-sources' }),
      outputFormat: Object.freeze({ supported: true, flag: '--output-format', default: 'json' }),
    }),
  }),
  'codex-cli': Object.freeze({ agentId: 'codex-cli', type: 'codex', command: null, implemented: false, labels: Object.freeze(['agent:codex', 'agent:codex-cli']), controls: Object.freeze({ ...FUTURE_CONTROLS }) }),
  'gpt-agent': Object.freeze({ agentId: 'gpt-agent', type: 'gpt', command: null, implemented: false, labels: Object.freeze(['agent:gpt', 'agent:openai']), controls: Object.freeze({ ...FUTURE_CONTROLS }) }),
  'gemini-cli': Object.freeze({ agentId: 'gemini-cli', type: 'gemini', command: null, implemented: false, labels: Object.freeze(['agent:gemini', 'agent:gemini-cli']), controls: Object.freeze({ ...FUTURE_CONTROLS }) }),
  'ollama-agent': Object.freeze({ agentId: 'ollama-agent', type: 'ollama', command: null, implemented: false, labels: Object.freeze(['agent:ollama']), controls: Object.freeze({ ...FUTURE_CONTROLS }) }),
});

const LABEL_TO_AGENT_ID = new Map(Object.values(AGENT_ADAPTERS).flatMap((adapter) => adapter.labels.map((label) => [label, adapter.agentId])));

export function allAgentLabels({ includeFuture = true } = {}) {
  return Object.values(AGENT_ADAPTERS)
    .filter((adapter) => includeFuture || adapter.implemented)
    .flatMap((adapter) => adapter.labels);
}

export function resolveAgentById(agentId = 'claude-code-cli') {
  return AGENT_ADAPTERS[agentId] || null;
}

export function resolveAgentForLabels(labels = []) {
  for (const label of labels.map((value) => String(value?.name || value || '').trim()).filter(Boolean)) {
    const agentId = LABEL_TO_AGENT_ID.get(label);
    if (agentId) return AGENT_ADAPTERS[agentId];
  }
  return null;
}

export function unsupportedAgentSkip(agent, { issueNumber = null, label = null } = {}) {
  const agentId = agent?.agentId || null;
  return {
    issue: issueNumber,
    reason: 'unsupported-agent',
    agentId,
    label,
    detail: agentId
      ? `Agent '${agentId}' is registered for future use but is not implemented by this runner.`
      : 'No supported agent adapter could be resolved for this issue.',
  };
}

export function validateAgentControls(agent, controls = {}, { ignoreUnsupported = false } = {}) {
  const diagnostics = [];
  for (const [name, value] of Object.entries(controls)) {
    if (value === undefined || value === null || value === false) continue;
    const capability = agent?.controls?.[name];
    if (!capability?.supported) diagnostics.push({ control: name, reason: 'unsupported-control', agentId: agent?.agentId || null });
  }
  if (diagnostics.length && !ignoreUnsupported) {
    const names = diagnostics.map((item) => item.control).join(', ');
    throw new Error(`Unsupported agent control(s) for ${agent?.agentId || 'unknown-agent'}: ${names}`);
  }
  return diagnostics;
}

export function agentRunMetadata(agent, profile = {}) {
  return {
    agentId: agent?.agentId || null,
    agentType: agent?.type || null,
    implemented: Boolean(agent?.implemented),
    model: profile.model || null,
    effort: profile.effort || null,
  };
}

export function buildAgentCommandArgs({ agent = resolveAgentById(), prompt, profile = {}, resumeSession, outputFormat } = {}) {
  if (!agent?.implemented) throw new Error(`Agent '${agent?.agentId || 'unknown'}' is not implemented`);
  validateAgentControls(agent, {
    model: profile.model,
    effort: profile.effort,
    maxBudgetUsd: profile.maxBudgetUsd,
    permissionMode: profile.permissionMode,
    resumeSession,
    outputFormat: outputFormat || agent.controls.outputFormat?.default,
    tools: profile.tools,
    allowedTools: profile.allowedTools,
    disallowedTools: profile.disallowedTools,
    worktree: profile.worktreeName,
    strictMcpConfig: profile.strictMcpConfig,
    disableSlashCommands: profile.disableSlashCommands,
    settings: profile.settings,
    settingSources: profile.settingSources,
  });
  const args = [];
  if (resumeSession) args.push(agent.controls.resumeSession.flag, resumeSession);
  if (profile.worktreeName) args.push(agent.controls.worktree.flag, profile.worktreeName);
  args.push('-p');
  args.push(agent.controls.model.flag, profile.model);
  args.push(agent.controls.effort.flag, profile.effort);
  // Implementation runs must be able to continue through discovery, edits,
  // validation and commit. Retain the legacy cap only for read-only plan mode
  // until the remaining profile/config cleanup in #27 is completed.
  if (profile.permissionMode === 'plan' && profile.maxTurns) {
    args.push(agent.controls.maxTurns.flag, String(profile.maxTurns));
  }
  args.push(agent.controls.maxBudgetUsd.flag, String(profile.maxBudgetUsd));
  args.push(agent.controls.permissionMode.flag, profile.permissionMode);
  if (profile.tools) args.push(agent.controls.tools.flag, profile.tools);
  if (profile.allowedTools) {
    const rules = Array.isArray(profile.allowedTools) ? profile.allowedTools : [profile.allowedTools];
    if (rules.length) args.push(agent.controls.allowedTools.flag, ...rules);
  }
  if (profile.disallowedTools) {
    const rules = Array.isArray(profile.disallowedTools) ? profile.disallowedTools : [profile.disallowedTools];
    if (rules.length) args.push(agent.controls.disallowedTools.flag, ...rules);
  }
  if (profile.strictMcpConfig) args.push(agent.controls.strictMcpConfig.flag);
  if (profile.disableSlashCommands) args.push(agent.controls.disableSlashCommands.flag);
  if (profile.settings) args.push(agent.controls.settings.flag, profile.settings);
  if (profile.settingSources !== undefined && profile.settingSources !== null) {
    args.push(agent.controls.settingSources.flag, profile.settingSources);
  }
  args.push(agent.controls.outputFormat.flag, outputFormat || agent.controls.outputFormat.default);
  args.push(prompt);
  return args;
}
