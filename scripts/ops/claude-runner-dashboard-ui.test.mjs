import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const index = readFileSync('.agent-runner/dashboard/index.html', 'utf8');
const script = readFileSync('.agent-runner/dashboard/dashboard.js', 'utf8');
const styles = readFileSync('.agent-runner/dashboard/styles.css', 'utf8');

test('runner dashboard exposes clear scheduler, execution, quota and queue summaries', () => {
  assert.match(index, /Issue executions/);
  assert.match(index, /Scheduler polls/);
  assert.match(index, /Runner activity/);
  assert.match(index, /Generated preflight fingerprints/);
  assert.match(index, /not ChatGPT or Claude model calls/);
});

test('runner dashboard renders dependency-free graphical history with table fallbacks', () => {
  for (const id of ['run-chart', 'quota-chart', 'skip-chart', 'run-history', 'quota-history', 'skip-reasons']) {
    assert.match(index, new RegExp(`id="${id}"`));
  }
  assert.match(script, /renderRunChart/);
  assert.match(script, /renderQuotaChart/);
  assert.match(script, /renderSkipChart/);
  assert.match(script, /<svg viewBox=/);
  assert.match(styles, /\.chart svg/);
  assert.doesNotMatch(index, /cdn|chart\.js|plotly|d3\.js/i);
});

test('runner dashboard uses a balanced global type scale', () => {
  assert.match(styles, /body\s*\{[\s\S]*font:\s*16px\/1\.55/);
  assert.match(styles, /\.eyebrow, \.label\s*\{[\s\S]*font-size:\s*\.875rem;/);
  assert.match(styles, /table\s*\{[^}]*font-size:\s*\.9375rem;/);
  assert.match(styles, /th\s*\{[\s\S]*font-size:\s*\.875rem;/);
  assert.match(styles, /\.badge\s*\{[\s\S]*font-size:\s*\.875rem;/);
  assert.match(styles, /\.chart-axis-label\s*\{[^}]*font-size:\s*14px;/);
});

test('queue skip distribution avoids SVG text scaling and keeps labels legible', () => {
  assert.match(script, /skip-chart-list/);
  assert.match(script, /role="list" aria-label="Queue skip counts by reason"/);
  assert.match(script, /skip-chart-label/);
  assert.match(script, /skip-chart-track/);
  assert.match(script, /skip-chart-count/);
  assert.match(styles, /\.skip-chart-label\s*\{[\s\S]*font-size:\s*1rem;/);
  assert.match(styles, /\.skip-chart-count\s*\{[\s\S]*font-size:\s*1rem;/);
  assert.match(styles, /\.skip-chart-row\s*\{[\s\S]*min-height:\s*2\.5rem;/);
  assert.doesNotMatch(script, /<text class="skip-label"/);
});

test('runner dashboard attention panel never renders dedupe_key and distinguishes resolved from unresolved events (#698 round 4, finding 4)', () => {
  // `dedupe_key` is deliberately absent from the dashboard API's positive
  // allowlist for attention_events (#698 finding 9); the client must not
  // reach for a field the API never sends.
  assert.doesNotMatch(script, /row\.dedupe_key/);
  assert.match(script, /row\.resolved_at/);
  assert.match(script, /badge ok/);
  assert.match(script, /badge warn/);
});
