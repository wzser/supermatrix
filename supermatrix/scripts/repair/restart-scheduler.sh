#!/usr/bin/env bash
set -u
# Scheduler v1 (port 3500) retired 2026-08-10.
# v2 runs on port 3502 and is supervised by localwatch
# (workspaces/scheduler/v2/start.sh). This script intentionally refuses to
# start v1 again; do not resurrect port 3500.
# Historical DB archive: /Users/LOCAL_USER/SuperMatrixRuntime/data/scheduler-backups/
echo "Scheduler v1 (port 3500) retired 2026-08-10; refusing to restart. Scheduler v2 is on :3502." >&2
exit 1
