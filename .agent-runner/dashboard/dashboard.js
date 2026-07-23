(function () {
  const data = window.RUNNER_DASHBOARD_DATA || null;
  const issueBaseUrl = 'https://github.com/';

  function text(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value == null || value === '' ? '—' : String(value);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  function fmtDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
  }

  function fmtDuration(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function issueLink(repo, issue) {
    if (!repo || !Number.isInteger(issue)) return issue ?? '—';
    const url = `${issueBaseUrl}${repo}/issues/${issue}`;
    return `<a href="${escapeHtml(url)}">#${issue}</a>`;
  }

  function renderTable(targetId, columns, rows, emptyMessage) {
    const target = document.getElementById(targetId);
    if (!target) return;
    if (!rows || rows.length === 0) {
      target.innerHTML = `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
      return;
    }
    const head = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('');
    const body = rows.map((row) => `<tr>${columns.map((column) => `<td>${column.render(row)}</td>`).join('')}</tr>`).join('');
    target.innerHTML = `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function renderDiagnostics(dashboard) {
    const diagnostics = dashboard.diagnostics || [];
    const panel = document.getElementById('diagnostics');
    if (!panel || diagnostics.length === 0) return;
    panel.hidden = false;
    if (diagnostics.some((item) => item.level === 'error')) panel.classList.add('error');
    panel.innerHTML = `<h2>Diagnostics</h2>${diagnostics.map((item) => `<p><strong class="${escapeHtml(item.level)}">${escapeHtml(item.code)}</strong>: ${escapeHtml(item.message)}</p>`).join('')}`;
  }

  function renderAttention(dashboard) {
    const rows = dashboard.latest?.attentionEvents || [];
    const attempts = dashboard.latest?.recoveryAttempts || [];
    // `rows` is the latest window of persisted attention events, resolved
    // and unresolved alike — treating every row as unresolved overstated how
    // many issues actually need attention right now (#698 round 4, finding
    // 4). Count and label only the still-unresolved subset; resolved rows
    // remain visible (audit trail) but are marked, not counted.
    const unresolvedCount = rows.filter((row) => !row.resolved_at).length;
    text('attention-summary', rows.length
      ? `${unresolvedCount} unresolved of ${rows.length} recent persisted attention event(s). Queue health remains task-local unless a systemic pause is reported.`
      : 'No persisted attention events.');
    const body = document.getElementById('attention-rows');
    if (!body) return;
    body.innerHTML = rows.map((row) => {
      const event = row.payload || {};
      const attempt = attempts.find((item) => item.attempt_id === row.attempt_id) || {};
      const evidence = `checkpoint:${Boolean(attempt.checkpoint_available)} session:${Boolean(attempt.session_available)} worktree:${Boolean(attempt.worktree_available)} branch:${Boolean(attempt.branch_available)} PR:${Boolean(attempt.pr_available)}`;
      const retry = `${attempt.recovery_attempt_count || 0} retries; next ${attempt.retry_at ? fmtDate(attempt.retry_at) : 'manager decision'}`;
      // `dedupe_key` is deliberately absent from the dashboard API's
      // positive allowlist for attention_events (#698 finding 9) and must
      // not be rendered here either.
      const statusBadge = row.resolved_at
        ? `<span class="badge ok">Resolved ${escapeHtml(fmtDate(row.resolved_at))}</span>`
        : '<span class="badge warn">Unresolved</span>';
      return `<tr><td>#${escapeHtml(row.issue_number)} / ${escapeHtml(event.agent || row.agent || 'unknown')} ${statusBadge}<br><small>Event-time status; not current GitHub status</small></td><td><code>${escapeHtml(row.reason)}</code><br><small>${escapeHtml(fmtDate(row.updated_at))}</small></td><td>${escapeHtml(row.recovery_status)}</td><td>${escapeHtml(evidence)}</td><td>${escapeHtml(retry)}</td><td>${escapeHtml(row.next_action)}</td></tr>`;
    }).join('');
  }

  function renderActivity(dashboard) {
    const activity = dashboard.activity || {};
    const target = document.getElementById('current-issue');
    if (!target) return;

    if (activity.status === 'empty' || (!activity.activeIssue && !activity.latestIssue)) {
      target.innerHTML = '<p class="muted">No selected, claimed or executed issue is recorded.</p>';
      return;
    }

    const row = activity.activeIssue || activity.latestIssue;
    const active = Boolean(activity.activeIssue);
    const badgeClass = active ? 'warn' : 'ok';
    const badgeText = active ? 'Active or unresolved claim' : 'Idle — latest activity only';
    target.innerHTML = `
      <p class="badge ${badgeClass}">${escapeHtml(badgeText)}</p>
      <h3>${issueLink(row.repo, row.issue_number)}</h3>
      <p class="muted">${escapeHtml(activity.message || '')}</p>
      <dl class="activity-grid">
        <dt>Record</dt><dd>${escapeHtml(row.kind || '—')}</dd>
        <dt>Mode</dt><dd>${escapeHtml(row.mode || '—')}</dd>
        <dt>Status</dt><dd>${escapeHtml(row.status_label || '—')}</dd>
        <dt>Time</dt><dd>${escapeHtml(fmtDate(row.timestamp))}</dd>
      </dl>`;
  }

  function runOutcome(row) {
    if (row?.mode === 'issue-run') return row.exit_code === 0 ? 'success' : 'failure';
    if (row?.mode === 'quota-blocked') return 'quota';
    return 'no-selection';
  }

  function runOutcomeLabel(row) {
    const outcome = runOutcome(row);
    if (outcome === 'success') return 'Implementation succeeded';
    if (outcome === 'failure') return 'Issue execution failed';
    if (outcome === 'quota') return 'Quota blocked';
    return 'No runnable issue';
  }

  function renderRunChart(rows) {
    const target = document.getElementById('run-chart');
    if (!target) return;
    const history = [...(rows || [])].reverse().slice(-40);
    if (history.length === 0) {
      target.innerHTML = '<div class="chart-empty">No scheduler history recorded yet.</div>';
      return;
    }

    const width = 760;
    const height = 150;
    const gap = 4;
    const barWidth = Math.max(5, Math.min(24, (width - ((history.length - 1) * gap)) / history.length));
    const usedWidth = history.length * barWidth + (history.length - 1) * gap;
    const offset = (width - usedWidth) / 2;
    const bars = history.map((row, index) => {
      const outcome = runOutcome(row);
      const x = offset + index * (barWidth + gap);
      const title = `${fmtDate(row.started_at || row.created_at)} — ${runOutcomeLabel(row)}${Number.isInteger(row.issue_number) ? ` — #${row.issue_number}` : ''}`;
      return `<rect class="run-bar-${outcome}" x="${x.toFixed(2)}" y="20" width="${barWidth.toFixed(2)}" height="100" rx="3"><title>${escapeHtml(title)}</title></rect>`;
    }).join('');

    target.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Timeline of recent scheduler results">
        <line class="chart-gridline" x1="0" y1="125" x2="${width}" y2="125"></line>
        ${bars}
        <text class="chart-axis-label" x="0" y="145">Older</text>
        <text class="chart-axis-label" x="${width - 34}" y="145">Newer</text>
      </svg>
      <div class="chart-legend">
        <span class="legend-item"><span class="legend-swatch success"></span>Issue success</span>
        <span class="legend-item"><span class="legend-swatch failure"></span>Issue failure</span>
        <span class="legend-item"><span class="legend-swatch quota"></span>Quota blocked</span>
        <span class="legend-item"><span class="legend-swatch no-selection"></span>No selection</span>
      </div>`;
  }

  function renderQuotaChart(rows) {
    const target = document.getElementById('quota-chart');
    if (!target) return;
    const history = [...(rows || [])]
      .reverse()
      .filter((row) => Number.isFinite(row.session_usage_percent) || Number.isFinite(row.weekly_usage_percent))
      .slice(-30);
    if (history.length === 0) {
      target.innerHTML = '<div class="chart-empty">Quota checks exist, but no percentage values were persisted.</div>';
      return;
    }

    const width = 650;
    const height = 220;
    const margin = { left: 36, right: 14, top: 14, bottom: 28 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const x = (index) => margin.left + (history.length === 1 ? innerWidth / 2 : (index / (history.length - 1)) * innerWidth);
    const y = (value) => margin.top + ((100 - value) / 100) * innerHeight;
    const points = (field) => history
      .map((row, index) => Number.isFinite(row[field]) ? `${x(index).toFixed(2)},${y(row[field]).toFixed(2)}` : null)
      .filter(Boolean)
      .join(' ');
    const circles = (field, className) => history.map((row, index) => {
      if (!Number.isFinite(row[field])) return '';
      return `<circle class="${className}" cx="${x(index).toFixed(2)}" cy="${y(row[field]).toFixed(2)}" r="3"><title>${escapeHtml(`${fmtDate(row.created_at)} — ${row[field]}%`)}</title></circle>`;
    }).join('');
    const grid = [0, 25, 50, 75, 100].map((value) => {
      const gridY = y(value);
      return `<line class="chart-gridline" x1="${margin.left}" y1="${gridY}" x2="${width - margin.right}" y2="${gridY}"></line><text class="chart-axis-label" x="3" y="${gridY + 4}">${value}%</text>`;
    }).join('');

    target.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Session and weekly Claude quota usage trend">
        ${grid}
        ${points('session_usage_percent') ? `<polyline class="chart-session" points="${points('session_usage_percent')}"></polyline>` : ''}
        ${points('weekly_usage_percent') ? `<polyline class="chart-weekly" points="${points('weekly_usage_percent')}"></polyline>` : ''}
        ${circles('session_usage_percent', 'chart-point-session')}
        ${circles('weekly_usage_percent', 'chart-point-weekly')}
        <text class="chart-axis-label" x="${margin.left}" y="${height - 5}">${escapeHtml(fmtDate(history[0].created_at))}</text>
        <text class="chart-axis-label" text-anchor="end" x="${width - margin.right}" y="${height - 5}">${escapeHtml(fmtDate(history[history.length - 1].created_at))}</text>
      </svg>
      <div class="chart-legend">
        <span class="legend-item"><span class="legend-line"></span>Current session</span>
        <span class="legend-item"><span class="legend-line weekly"></span>Current week</span>
      </div>`;
  }

  function renderSkipChart(rows) {
    const target = document.getElementById('skip-chart');
    if (!target) return;
    const history = (rows || []).slice(0, 8);
    if (history.length === 0) {
      target.innerHTML = '<div class="chart-empty">No queue skip reasons recorded yet.</div>';
      return;
    }

    const max = Math.max(...history.map((row) => Number(row.count) || 0), 1);
    const bars = history.map((row) => {
      const count = Number(row.count) || 0;
      const percentage = Math.max(2, (count / max) * 100);
      const reason = escapeHtml(row.reason);
      return `
        <div class="skip-chart-row" role="listitem" aria-label="${reason}: ${count} events">
          <span class="skip-chart-label">${reason}</span>
          <span class="skip-chart-track" aria-hidden="true"><span class="skip-chart-bar" style="width:${percentage.toFixed(2)}%"></span></span>
          <strong class="skip-chart-count">${count}</strong>
        </div>`;
    }).join('');

    target.innerHTML = `<div class="skip-chart-list" role="list" aria-label="Queue skip counts by reason">${bars}</div>`;
  }

  function render(dashboard) {
    if (!dashboard) {
      document.body.innerHTML = '<main><section class="panel diagnostics error"><h1>Dashboard data missing</h1><p>Generate dashboard-data.js with the local dashboard command, or provide a dashboard JSON payload.</p></section></main>';
      return;
    }
    const latest = dashboard.latest || {};
    const metrics = dashboard.metrics || {};
    const counts = dashboard.counts || {};
    const hasRows = Object.values(counts).some((count) => Number(count) > 0);

    text('status-value', dashboard.operatorStatus?.label || dashboard.status || (dashboard.ok ? 'ok' : 'error'));
    text('generated-at', fmtDate(dashboard.generatedAt));
    text('db-path', dashboard.dbPath);
    text('metric-runs', metrics.runs?.issueRuns ?? metrics.runs?.total ?? 0);
    text('metric-runs-detail', `${metrics.runs?.succeeded ?? 0} succeeded / ${metrics.runs?.failed ?? 0} failed · avg ${fmtDuration(metrics.runs?.averageDurationSeconds)}`);
    text('metric-polls', metrics.runs?.schedulerPolls ?? 0);
    text('metric-polls-detail', `${metrics.runs?.noSelectionPolls ?? 0} no selection · ${metrics.runs?.quotaBlockedPolls ?? 0} quota blocked`);
    text('metric-quota', metrics.quota?.latestSessionUsagePercent == null ? '—' : `${metrics.quota.latestSessionUsagePercent}%`);
    text('metric-quota-detail', `Weekly ${metrics.quota?.latestWeeklyUsagePercent ?? '—'}% · ${metrics.quota?.blockedCount ?? 0} blocked samples`);
    text('metric-skips', metrics.queue?.skipEventCount ?? 0);
    text('metric-skips-detail', `${metrics.queue?.skippedIssueCount ?? 0} issues · ${metrics.queue?.skipReasonCount ?? 0} reason types`);
    text('metric-eta', metrics.eta?.status || '—');
    text('metric-eta-detail', metrics.eta?.estimatedSecondsLow ? `${fmtDuration(metrics.eta.estimatedSecondsLow)}–${fmtDuration(metrics.eta.estimatedSecondsHigh)}` : (metrics.eta?.message || '—'));

    renderDiagnostics(dashboard);
    renderAttention(dashboard);
    const empty = document.getElementById('empty-state');
    if (empty) empty.hidden = hasRows && dashboard.status !== 'missing';
    renderActivity(dashboard);
    renderRunChart(latest.runResults || latest.runs || []);
    renderQuotaChart(latest.quota || []);
    renderSkipChart(dashboard.aggregates?.skippedQueueReasons || []);

    renderTable('run-history', [
      { label: 'Issue', render: (row) => issueLink(row.repo, row.issue_number) },
      { label: 'Result type', render: (row) => escapeHtml(row.mode || '—') },
      { label: 'Meaning', render: (row) => escapeHtml(runOutcomeLabel(row)) },
      { label: 'Exit', render: (row) => escapeHtml(row.exit_code ?? row.signal ?? '—') },
      { label: 'Started', render: (row) => escapeHtml(fmtDate(row.started_at || row.created_at)) },
      { label: 'Log', render: (row) => escapeHtml(row.log_path || '—') },
    ], latest.runResults || latest.runs || [], 'No scheduler results recorded yet.');

    renderTable('quota-history', [
      { label: 'When', render: (row) => escapeHtml(fmtDate(row.created_at)) },
      { label: 'Status', render: (row) => escapeHtml(row.status || row.reason || '—') },
      { label: 'Session', render: (row) => escapeHtml(row.session_usage_percent == null ? '—' : `${row.session_usage_percent}%`) },
      { label: 'Weekly', render: (row) => escapeHtml(row.weekly_usage_percent == null ? '—' : `${row.weekly_usage_percent}%`) },
      { label: 'Reset', render: (row) => escapeHtml(fmtDate(row.reset_at)) },
    ], latest.quota || [], 'No quota samples recorded yet.');

    renderTable('skip-reasons', [
      { label: 'Reason', render: (row) => escapeHtml(row.reason) },
      { label: 'Events', render: (row) => escapeHtml(row.count) },
      { label: 'Latest', render: (row) => escapeHtml(fmtDate(row.latestAt)) },
    ], dashboard.aggregates?.skippedQueueReasons || [], 'No skipped queue reasons recorded yet.');

    renderTable('preflight-fingerprints', [
      { label: 'Issue', render: (row) => issueLink(row.repo, row.issue_number) },
      { label: 'Fingerprint', render: (row) => `<code>${escapeHtml(row.fingerprint)}</code>` },
      { label: 'Action', render: (row) => escapeHtml(row.action || '—') },
      { label: 'Created', render: (row) => escapeHtml(fmtDate(row.created_at)) },
    ], dashboard.aggregates?.preflightFingerprints || [], 'No manager packet authority fingerprints recorded yet.');
  }

  render(data);
}());
