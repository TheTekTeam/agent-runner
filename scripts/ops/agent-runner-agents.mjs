import { assertClaudePromptCacheEnabled } from './claude-runner-cache-policy.mjs';
import { appendLiveDeterministicHandoff } from './agent-runner-deterministic-live-handoff.mjs';

export const SHARED_CODEX_CLAUDE_LABEL = 'agent:codex-claude';
export const DETERMINISTIC_HANDOFF_ENV = 'AGENT_RUNNER_DETERMINISTIC_HANDOFF_JSON';

export const AGENT_ASSIGNMENT_DISPLAY_NAMES = Object.freeze({
  [SHARED_CODEX_CLAUDE_LABEL]: 'Codex / Claude',
});

const FUTURE_CONTROLS = {
  model: { supported: false },
  effort: { supported: false },
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
  excludeDynamicSystemPromptSections: { supported: false },
};

export const AGENT_ADAPTERS = Object.freeze({
  'claude-code-cli': Object.freeze({
    agentId: 'claude-code-cli',
    type: 'claude',
    command: 'claude',
    implemented: true,
    // The composite label is one assignment choice, not two simultaneous
    // agents. Local execution resolves it to the already-qualified Claude
    // adapter; Codex Web remains a manager/manual route outside this process.
    labels: Object.freeze(['agent:claude', 'agent:claude-code-cli', SHARED_CODEX_CLAUDE_LABEL]),
    controls: Object.freeze({
      model: Object.freeze({ supported: true, flag: '--model' }),
      effort: Object.freeze({ supported: true, flag: '--effort' }),
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
      excludeDynamicSystemPromptSections: Object.freeze({ supported: true, flag: '--exclude-dynamic-system-prompt-sections' }),
      outputFormat: Object.freeze({ supported: true, flag: '--output-format', default: 'json' }),
    }),
  }),
  // `agent:codex` intentionally has no adapter entry anywhere in this
  // catalogue: it identifies Codex Web/manual work and must never resolve to
  // a local process. Only `agent:codex-cli` identifies this adapter.
  'codex-cli': Object.freeze({ agentId: 'codex-cli', type: 'codex', command: null, implemented: false, labels: Object.freeze(['agent:codex-cli']), controls: Object.freeze({ ...FUTURE_CONTROLS }) }),
  // Foundation-only (issue #49): command stays null and implemented stays
  // false so no live dispatch can route to Grok under this issue. Only
  // agent:grok-cli identifies this adapter.
  'grok-cli': Object.freeze({ agentId: 'grok-cli', type: 'grok', command: null, implemented: false, labels: Object.freeze(['agent:grok-cli']), controls: Object.freeze({ ...FUTURE_CONTROLS }) }),
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

export function agentAssignmentDisplayName(label = '') {
  const value = String(label?.name || label || '').trim();
  return AGENT_ASSIGNMENT_DISPLAY_NAMES[value] || value || null;
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
  const assignmentLabel = String(profile.assignmentLabel || '').trim() || null;
  return {
    agentId: agent?.agentId || null,
    agentType: agent?.type || null,
    implemented: Boolean(agent?.implemented),
    model: profile.model || null,
    effort: profile.effort || null,
    ...(assignmentLabel ? {
      assignmentLabel,
      assignmentDisplayName: agentAssignmentDisplayName(assignmentLabel),
    } : {}),
  };
}

export function hydratePromptWithDeterministicHandoff(prompt, env = process.env, { agentId = 'claude-code-cli' } = {}) {
  return appendLiveDeterministicHandoff(prompt, env, { agentId });
}

export function buildAgentCommandArgs({
  agent = resolveAgentById(),
  prompt,
  profile = {},
  resumeSession,
  outputFormat,
  env = process.env,
  allowDisabledPromptCaching = false,
} = {}) {
  if (!agent?.implemented) throw new Error(`Agent '${agent?.agentId || 'unknown'}' is not implemented`);

  const cacheStableImplementation = agent.type === 'claude' && profile.permissionMode === 'dontAsk';
  if (agent.type === 'claude') {
    assertClaudePromptCacheEnabled({
      model: profile.model,
      env,
      allowDisabled: allowDisabledPromptCaching,
    });
  }

  validateAgentControls(agent, {
    model: profile.model,
    effort: profile.effort,
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
    excludeDynamicSystemPromptSections: cacheStableImplementation,
  });
  const args = [];
  if (resumeSession) args.push(agent.controls.resumeSession.flag, resumeSession);
  if (profile.worktreeName) args.push(agent.controls.worktree.flag, profile.worktreeName);
  args.push('-p');
  if (cacheStableImplementation) args.push(agent.controls.excludeDynamicSystemPromptSections.flag);
  args.push(agent.controls.model.flag, profile.model);
  args.push(agent.controls.effort.flag, profile.effort);
  // Subscription-backed Claude execution has no dollar-denominated attempt
  // ceiling. Mandatory quota/headroom admission remains the provider gate.
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
  args.push(hydratePromptWithDeterministicHandoff(prompt, env, { agentId: agent.agentId }));
  return args;
}
