---
"@ai-hero/sandcastle": patch
---

Add GitHub Copilot CLI agent provider (`copilotCli`).

The new `copilotCli` factory runs the standalone `copilot` binary (or `gh copilot`, which delegates to the same binary) in non-interactive mode with JSONL output. It supports:

- `--output-format json` streaming with text delta, result, tool call, and session ID events parsed from the JSONL stream
- `--resume` for session continuity across iterations
- `--effort` / `--reasoning-effort` levels (`low`, `medium`, `high`, `xhigh`)
- `--allow-all` (full autonomy) or `--allow-all-tools` based on `dangerouslySkipPermissions`
- `buildInteractiveArgs` for interactive mode via `copilot -i`

A matching Dockerfile template is included for `sandcastle init`, installing `gh` (which auto-downloads the `copilot` binary on first run) and adding `~/.local/share/gh/copilot` to `PATH`. Authentication is via `GH_TOKEN`, which also covers GitHub Issues commands when that backlog manager is selected.
