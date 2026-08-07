# Agent Runner bounded PR publication

`npm run pr:publish -- --project-registry REGISTRY --executor-policy POLICY --db STATE.sqlite --request-file REQUEST.json` is a non-root, one-shot draft-PR publication surface. It accepts only the versioned PR.CONTRACT.1 request and produces bounded JSON.

Before every GitHub write it re-reads the issue, source and target refs, open draft PRs, current manager packet and durable validation evidence. It only creates/adopts one compatible draft PR or applies a bounded body update. A durable SQLite transaction makes replays and restart adoption deterministic.

It cannot merge, enable auto-merge, approve, close issues, mutate labels, delete branches, force-push, deploy, or start unattended work. Provider ambiguity, duplicate/conflicting PRs, stale authority, changed heads/bases and expired validation refuse without publishing.
