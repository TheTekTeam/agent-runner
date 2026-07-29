import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runPollingControllerCommand } from './agent-runner-polling-controller-cycle.mjs';

function countBy(items, key) {
  const counts = {};
  for (const item of items ?? []) {
    const value = item?.[key] ?? 'unknown';
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.freeze(Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))));
}

export function summarizePollingControllerResult(result) {
  const pollingOutcomes = result?.polling?.outcomes ?? [];
  const controllerOutcomes = result?.controller?.outcomes ?? [];
  return Object.freeze({
    schemaVersion: 1,
    observedAt: result?.observedAt ?? null,
    polling: Object.freeze({
      projectsInspected: result?.polling?.projectsInspected ?? 0,
      deliveriesInserted: result?.polling?.deliveriesInserted ?? 0,
      duplicateDeliveries: result?.polling?.duplicateDeliveries ?? 0,
      projectErrors: pollingOutcomes.filter((item) => item?.errorCode).length,
      projects: Object.freeze(pollingOutcomes.map((item) => Object.freeze({
        projectId: item.projectId,
        bootstrap: Boolean(item.bootstrap),
        issuesObserved: item.issuesObserved ?? 0,
        pullRequestsObserved: item.pullRequestsObserved ?? 0,
        deliveriesInserted: item.deliveriesInserted ?? 0,
        duplicateDeliveries: item.duplicateDeliveries ?? 0,
        errorCode: item.errorCode ?? null,
      }))),
    }),
    controller: Object.freeze({
      deliveriesAttached: result?.controller?.deliveriesAttached ?? 0,
      deliveriesIgnored: result?.controller?.deliveriesIgnored ?? 0,
      batchesInspected: result?.controller?.batchesInspected ?? 0,
      releasesCreated: result?.controller?.releasesCreated ?? 0,
      pendingReleases: result?.controller?.pendingReleases ?? 0,
      states: countBy(controllerOutcomes, 'state'),
      reasons: countBy(controllerOutcomes, 'reason'),
      providerDiagnosticCount: controllerOutcomes.reduce(
        (sum, item) => sum + (Array.isArray(item?.providerDiagnostics) ? item.providerDiagnostics.length : 0),
        0,
      ),
    }),
  });
}

export async function runPollingControllerSummaryCommand({
  argv = process.argv.slice(2),
  env = process.env,
  observedAt = new Date().toISOString(),
} = {}) {
  const result = await runPollingControllerCommand({ argv, env, observedAt });
  return result.help ? result : summarizePollingControllerResult(result);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  runPollingControllerSummaryCommand().then((result) => {
    if (result.help) process.stdout.write(`${result.help}\n`);
    else process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code ?? 'polling-controller-failed' })}\n`);
    process.exitCode = 1;
  });
}
