import { assertClaudePromptCacheEnabled } from './claude-runner-cache-policy.mjs';
import { appendLiveDeterministicHandoff } from './agent-runner-deterministic-live-handoff.mjs';
import { chooseContextBudget } from './agent-runner-context-budget.mjs';

export const SHARED_CODEX_CLAUDE_LABEL = 'agent:codex-claude';
export const DETERMINISTIC_HANDOFF_ENV = 'AGENT_RUNNER_DETERMINISTIC_HANDOFF_JSON';
export const CLAUDE_MAX_TURNS_ENABLE_ENV = 'AGENT_RUNNER_CLAUDE_MAX_TURNS_ENABLED';
export const CLAUDE_MAX_TURNS_QUALIFICATION_ENV = 'AGENT_RUNNER_CLAUDE_MAX_TURNS_QUALIFICATION_REVISION';
export const CLAUDE_NATIVE_RESUME_ENABLE_ENV = 'CLAUDE_RUNNER_ENABLE_NATIVE_RESUME';

export const AGENT_ASSIGNMENT_DISPLAY_NAMES = Object.freeze({
  [SHARED_CODEX_CLAUDE_LABEL]: 'Codex / Claude',
});

const FUTURE_CONTROLS = {
  model: { supported: false },
  effort: { supported: false },
  maxTurns: { supported: false },
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
      // #320: source support is present, but live use is separately gated by
      // a machine-local qualification revision plus explicit enablement. The
      // current official Claude Code CLI reference documents --max-turns for
      // print mode; repository source must not assume an installed binary is
      // qualified merely because the documentation says the flag exists.
      maxTurns: Object.freeze({ supported: true, flag: '--max-turns' }),
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
  // #377: live only through agent-runner-ollama-runner.mjs. The scheduler may
  // select this adapter only after the ordinary lifecycle/readiness/
  // qualification gates pass; the child independently revalidates the exact
  // machine-local model, OpenCode/Ollama versions, manager authority,
  // worktree scope and bounded shell policy before any model invocation.
  'ollama-agent': Object.freeze({ agentId: 'ollama-agent', type: 'ollama', command: 'opencode', implemented: true, labels: Object.freeze(['agent:ollama']), controls: Object.freeze({ ...FUTURE_CONTROLS }) }),
});

const LABEL_TO_AGENT_ID = new Map(Object.values(AGENT_ADAPTERS).flatMap((adapter) => adapter.labels.map((label) => [label, adapter.agentId])));

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function qualificationRevision(value) {
  const revision = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,160}$/.test(revision) ? revision : null;
}

function taskClassForProfile(profile = {}) {
  const name = String(profile.profile || '').trim().toLowerCase();
  if (name === 'docs') return 'routine';
  if (name === 'narrow') return 'narrow';
  if (name === 'complex') return 'complex';
  if (name === 'critical') return 'critical';
  return 'normal';
}

export function claudeMaxTurnsPolicy(profile = {}, env = process.env) {
  const revision = qualificationRevision(env[CLAUDE_MAX_TURNS_QUALIFICATION_ENV]);
  const enabled = truthy(env[CLAUDE_MAX_TURNS_ENABLE_ENV]);
  const recoveryEnabled = truthy(env[CLAUDE_NATIVE_RESUME_ENABLE_ENV]);
  const taskClass = taskClassForProfile(profile);
  const adapterCapable = Boolean(revision && enabled && recoveryEnabled);
  const budget = chooseContextBudget({
    taskClass,
    risk: taskClass === 'critical' ? 'critical' : 'normal',
    adapterCapabilities: { maxTurns: adapterCapable },
    requestedReasoningEffort: profile.effort || null,
  });
  const active = Boolean(adapterCapable && Number.isInteger(budget.providerControls.maxTurns));
  return Object.freeze({
    active,
    qualificationRevision: revision,
    taskClass,
    maxTurns: active ? budget.providerControls.maxTurns : null,
    reason: active
      ? 'machine-qualified-task-class-turn-budget'
      : !revision
        ? 'machine-qualification-missing'
        : !enabled
          ? 'machine-enable-gate-off'
          : !recoveryEnabled
            ? 'native-resume-recovery-gate-off'
            : 'turn-budget-unavailable',
  });
}

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

export function hydratePromptWithDeterministicHandoff(prompt, env = process.env, {
  agentId = 'claude-code-cli',
  deltaOnly = false,
} = {}) {
  return appendLiveDeterministicHandoff(prompt, env, { agentId, deltaOnly });
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
  const maxTurnsPolicy = agent.type === 'claude' ? claudeMaxTurnsPolicy(profile, env) : null;
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
    maxTurns: maxTurnsPolicy?.maxTurns,
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
  if (maxTurnsPolicy?.active) args.push(agent.controls.maxTurns.flag, String(maxTurnsPolicy.maxTurns));
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
  // Only an explicitly bound resume session may receive a delta-only handoff.
  // Fresh tasks continue to receive the full bounded deterministic capsule.
  args.push(hydratePromptWithDeterministicHandoff(prompt, env, {
    agentId: agent.agentId,
    deltaOnly: Boolean(resumeSession),
  }));
  return args;
}
