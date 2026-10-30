# Isolated orchestration V2 servers

Use `scripts/v2-sandbox.ts` to run one or two disposable V2 servers from a copied T3 home. It binds every server to `127.0.0.1`, assigns a separate home and fresh environment identity to each instance, rejects paths that overlap `~/.t3`, and stops only the child PIDs it spawned.

Keep the copied template, destination home and logs in your assigned job. Never pass `~/.t3` or a home used by a live server.

```bash
workenv capacity --disk 2 --ram 2

node scripts/v2-sandbox.ts run \
  --source-home /data/jobs/t3-v2-example/copied-t3-home \
  --sandbox-root /data/jobs/t3-v2-example/run-1 \
  --port 15431 \
  --port 15432 \
  --cwd /data/jobs/t3-v2-example/worktree
```

Pass `--empty` instead of `--source-home` to verify a clean V2 boot. The checked-in source tree is sufficient; a web build is not required for the server readiness probe.

The command stays in the foreground. Once both `/userdata/server-runtime.json` records carry the spawned PID and chosen port and HTTP answers, it writes `sandbox.json` with the sandbox ID, PIDs, homes, origins and log paths. Ctrl-C, `SIGTERM` or `SIGHUP` sends `SIGTERM` to those exact children, waits up to ten seconds, then sends `SIGKILL` only to a child still present in its original process handle. Do not stop instances by name or process search.

The template copy deliberately omits `runtime`, `caches`, `worktrees`, runtime identity, ownership and runtime-state files, logs and browser artifacts. A copied `statev2.sqlite` wins at runtime; a copied V1 `state.sqlite` is snapshotted to `statev2.sqlite` by the upstream importer. Neither source database is modified by this script.
