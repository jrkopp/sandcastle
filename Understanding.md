# Understanding the Sandcastle Codebase

## Overview

Sandcastle is a TypeScript CLI and library that orchestrates AI coding agents (e.g. Claude Code, Codex) inside isolated sandbox environments (Docker, Podman, or Vercel VMs). It manages the full lifecycle: scaffolding configuration files, building container images, launching sandboxes, injecting prompts and credentials, running the agent iteratively, capturing commits, and merging them back to the host.

---

## Codebase Organization

```
src/
  cli.ts               — CLI entry point; implements `init`, `run`, and image-management commands
  InitService.ts       — Dockerfile templates, agent/sandbox/backlog registries, scaffold logic
  run.ts               — Public `run()` API; wires providers, env, logging, and the Effect runtime
  Orchestrator.ts      — Iteration loop; invokes the agent, handles completion signals, collects commits
  SandboxFactory.ts    — Effect service that creates/tears down worktrees and sandboxes
  SandboxLifecycle.ts  — Per-iteration in-sandbox setup (git identity, hooks, commit collection, merge-back)
  startSandbox.ts      — Dispatches to bind-mount or isolated sandbox start paths
  DockerLifecycle.ts   — Docker CLI wrappers: buildImage, startContainer, removeContainer, removeImage
  PodmanLifecycle.ts   — Podman equivalents of the Docker wrappers
  AgentProvider.ts     — Agent interface + built-in implementations (claudeCode, codex, pi, opencode)
  SandboxProvider.ts   — Sandbox provider interface (BindMount, Isolated, NoSandbox)
  EnvResolver.ts       — Reads .sandcastle/.env, merges with process.env
  PromptResolver.ts    — Reads promptFile or accepts inline prompt string
  PromptPreprocessor.ts — Expands `!`command`` shell expressions inside prompt files
  PromptArgumentSubstitution.ts — Replaces {{KEY}} placeholders in prompts
  WorktreeManager.ts   — git worktree create/remove/prune helpers
  syncIn.ts            — Transfers host repo into isolated sandbox via git bundle
  syncOut.ts           — Transfers agent commits from isolated sandbox back to host via git patches
  CopyToWorktree.ts    — Copies host paths (e.g. node_modules) into a worktree
  SandboxLifecycle.ts  — Hook runner, git setup, branch creation, commit collection, merge
  SessionStore.ts      — Captures / restores Claude Code session JSONL files
  templates/           — Scaffold templates (blank, simple-loop, sequential-reviewer, parallel-planner, …)
```

### Key abstractions

| Abstraction       | File                 | Purpose                                                                             |
| ----------------- | -------------------- | ----------------------------------------------------------------------------------- |
| `AgentProvider`   | `AgentProvider.ts`   | Interface for building agent CLI commands and parsing their output stream           |
| `SandboxProvider` | `SandboxProvider.ts` | Interface for creating/tearing down a sandbox environment                           |
| `SandboxFactory`  | `SandboxFactory.ts`  | Effect service that wraps worktree creation and sandbox lifecycle                   |
| `SandboxConfig`   | `SandboxFactory.ts`  | Effect context tag holding all runtime configuration for a run                      |
| `SandboxService`  | `SandboxFactory.ts`  | Effect service exposing `exec`, `copyIn`, `copyFileOut` against the running sandbox |
| `Display`         | `Display.ts`         | Effect service for terminal UI (Clack) or file-based log output                     |

---

## The `init` Command — Flow

`sandcastle init` scaffolds the `.sandcastle/` directory and optionally builds the container image.

### Step-by-step

1. **Interactive prompts** (`cli.ts` → `initCommand`):
   - Select an **agent** (claude-code, pi, codex, opencode) — `listAgents()` / `getAgent()` from `InitService.ts`.
   - Select a **model** (defaults to the agent's `defaultModel`).
   - Select a **sandbox provider** (Docker or Podman) — `listSandboxProviders()` from `InitService.ts`.
   - Select a **backlog manager** (GitHub Issues or Beads) — `listBacklogManagers()` from `InitService.ts`.
   - Select a **template** (blank, simple-loop, sequential-reviewer, parallel-planner, …).
   - Optionally create a `Sandcastle` GitHub label (used by issue-list commands in the prompt).

2. **Scaffold** — `scaffold()` in `InitService.ts`:
   - Creates `.sandcastle/` directory.
   - Writes `.sandcastle/.gitignore` (ignores `.env`, `logs/`, `worktrees/`).
   - Copies template files from `src/templates/<templateName>/` into `.sandcastle/`.
   - Renames `main.mts` → `main.ts` when appropriate.
   - **Generates the Dockerfile** (see below).
   - Writes `.sandcastle/.env.example` with agent- and backlog-manager-specific env var keys.
   - Rewrites `main.ts` to use the correct agent factory function and model string.
   - Substitutes `{{KEY}}` placeholders (e.g. `{{LIST_TASKS_COMMAND}}`) with backlog-manager-specific values in all text files.
   - Optionally strips `--label Sandcastle` from prompt files if the user opted out of the label.

3. **Optionally build the container image** — calls `buildImage()` / `podmanBuildImage()` from `DockerLifecycle.ts` / `PodmanLifecycle.ts` using the generated `Dockerfile` or `Containerfile` in `.sandcastle/`.

---

## How the Dockerfile Is Generated

The Dockerfile is assembled from two pieces:

### 1. Agent-specific Dockerfile template

`InitService.ts` stores a static Dockerfile string per agent (e.g. `CLAUDE_CODE_DOCKERFILE`, `CODEX_DOCKERFILE`, `PI_DOCKERFILE`, `OPENCODE_DOCKERFILE`). All share the same skeleton:

```dockerfile
FROM node:22-bookworm

# System tools: git, curl, jq
RUN apt-get update && apt-get install -y git curl jq ...

{{BACKLOG_MANAGER_TOOLS}}      # placeholder — replaced below

# UID/GID alignment build args
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the "node" user to "agent" and align UID/GID
RUN groupmod -g $AGENT_GID node && usermod ... -l agent node

USER ${AGENT_UID}:${AGENT_GID}

# Agent-specific install (e.g. Claude Code via install.sh, or npm install -g @openai/codex)
RUN curl -fsSL https://claude.ai/install.sh | bash

ENV PATH="/home/agent/.local/bin:$PATH"
WORKDIR /home/agent

# Container stays alive; Sandcastle exec()s commands into it
ENTRYPOINT ["sleep", "infinity"]
```

### 2. Backlog manager tool injection

The `{{BACKLOG_MANAGER_TOOLS}}` placeholder is replaced with the tool installation block registered for the selected backlog manager:

- **GitHub Issues** → installs the `gh` (GitHub CLI) via the official APT repository.
- **Beads** → installs system dependencies (`libicu72`) and the Beads CLI from its install script.

This substitution happens in `substituteTemplateArgs()` within `InitService.ts`, which replaces all `{{KEY}}` tokens throughout every text file in `.sandcastle/`.

### Key Dockerfile design choices

- **UID/GID alignment**: `AGENT_UID` and `AGENT_GID` build args default to `1000` but are overridden at `docker build` time by `defaultUidBuildArgs()` in `cli.ts`, which reads the host user's actual `uid`/`gid`. This ensures files written inside the container are owned by the host user, preventing permission errors with bind-mounted directories.
- **`sleep infinity` entrypoint**: The container starts and stays idle; Sandcastle issues commands via `docker exec` rather than baking a single command into the image.
- **Separate agent installs**: Each agent is installed as its user (`agent`) so credentials and config files land in `/home/agent/.local/` or similar, matching Claude Code's expectations.

---

## Dockerfile Steps Summary

| Step                                   | Purpose                                                          |
| -------------------------------------- | ---------------------------------------------------------------- |
| `FROM node:22-bookworm`                | Debian Bookworm base with Node 22 pre-installed                  |
| `apt-get install git curl jq`          | Core tools every agent needs                                     |
| Backlog manager tooling                | `gh` CLI or Beads CLI depending on selection                     |
| `ARG AGENT_UID / AGENT_GID`            | Accept host UID/GID at build time                                |
| `groupmod / usermod`                   | Rename `node` user to `agent`, align UID/GID                     |
| Agent install (as root, before `USER`) | Install agent CLI globally (e.g. `npm install -g @openai/codex`) |
| `USER ${AGENT_UID}:${AGENT_GID}`       | Drop privileges to the agent user                                |
| Claude Code: `curl install.sh \| bash` | Installs Claude Code as the agent user                           |
| `WORKDIR /home/agent`                  | Set working directory                                            |
| `ENTRYPOINT ["sleep", "infinity"]`     | Keep container alive for `docker exec`                           |

---

## The `run()` Function — Flow

`run()` in `run.ts` is the public API entry point. The CLI `run` command and template `main.ts` files call it.

### Step-by-step

1. **Validate options** — checks branch strategy vs. sandbox provider compatibility, `resumeSession` constraints, `output` constraints.

2. **Resolve `cwd`** — `resolveCwd()` determines the host repo directory (defaults to `process.cwd()`).

3. **Resolve the prompt** — `resolvePrompt()` reads the prompt file or uses the inline string.

4. **Resolve environment variables** — `resolveEnv()` reads `.sandcastle/.env`, falling back to `process.env` for keys declared in that file. Result is merged with `provider.env` (agent-specific vars) and `sandbox.env` (provider-specific vars) by `mergeProviderEnv()`.

5. **Determine branch strategy** — explicit option, or defaulted: `merge-to-head` for isolated providers, `head` for bind-mount providers.

6. **Set up logging** — either a `FileDisplay` (log to `.sandcastle/logs/<branch>.log`) or `ClackDisplay` (interactive terminal UI).

7. **Build Effect layers** — `WorktreeDockerSandboxFactory.layer` is assembled with `SandboxConfig`, the file system layer, and the display layer.

8. **Run `orchestrate()`** — the core iteration loop (see below).

9. **Return `RunResult`** — iterations, commits, branch name, log path, optional structured output.

---

## How `run()` Creates and Uses the VM

### Bind-mount sandbox (Docker / Podman)

1. `SandboxFactory.withSandbox()` (`SandboxFactory.ts`) creates a git **worktree** under `.sandcastle/worktrees/` via `WorktreeManager.create()`.
2. `startSandbox()` → `startBindMountSandbox()` → calls `provider.create()` (the Docker provider's factory, e.g. from `sandboxes/docker.ts`), which calls `DockerLifecycle.startContainer()`.
3. `startContainer()` runs:
   ```
   docker run -d --name <containerName>
     -e KEY=VALUE ...         # env vars (API keys, GH_TOKEN, etc.)
     -v <worktreePath>:/home/agent/workspace  # project files
     -v <gitPath>:/path/to/.git               # git metadata
     -w /home/agent/workspace
     --user <uid>:<gid>
     <imageName>
   ```
4. The container stays alive (`sleep infinity`). All subsequent commands are run via `docker exec <containerName> sh -c "<command>"`.

### Isolated sandbox (Vercel)

1. `provider.create()` starts a Vercel Firecracker microVM.
2. `syncIn()` transfers the host repo into the sandbox:
   - Runs `git bundle create --all` on the host.
   - `copyIn`s the bundle file into the sandbox.
   - Runs `git clone <bundle>` inside the sandbox at `handle.worktreePath`.
3. Optional `copyPaths` (e.g. `node_modules`) are copied in one at a time via `handle.copyIn()`.

---

## How the Development Project and Keys Are Loaded

### API keys and credentials

- `.sandcastle/.env` holds `ANTHROPIC_API_KEY`, `GH_TOKEN`, and any other credentials.
- `resolveEnv()` reads this file at `run()` time. Values present in the file but empty fall back to `process.env` (so CI environment variables work without modifying the file).
- `mergeProviderEnv()` merges the resolved env with agent-provider env and sandbox-provider env, producing the final `Record<string, string>` passed to the container.
- `startContainer()` injects these as `-e KEY=VALUE` flags so every `docker exec` inherits them.

### Project source code

- **Bind-mount (Docker/Podman)**: the git worktree is bind-mounted at `/home/agent/workspace` (`SANDBOX_REPO_DIR`). The agent sees the live working tree with no copy step; changes it writes appear directly in the host worktree.
- **Isolated (Vercel)**: `syncIn()` uses a git bundle to clone the entire repository into the sandbox. After the agent commits, `syncOut()` extracts the new commits via `git format-patch` and applies them to the host worktree with `git am`.
- **`copyToWorktree`**: specified paths (typically `node_modules`) are copied from the host worktree into the sandbox before the agent runs, avoiding a full `npm install` from scratch on every iteration.

### Git identity

Inside `withSandboxLifecycle()`, before the agent starts, Sandcastle:

1. Runs `git config --global --add safe.directory` to allow git operations in the bind-mounted directory.
2. Reads the host user's `git config user.name` and `user.email`.
3. Sets them inside the sandbox with `git config --global user.name/email`, so commits are attributed to the correct developer.

---

## How the Issue to Work On Is Chosen

Issue selection is entirely **prompt-driven** — there is no issue-picker built into Sandcastle itself. The mechanism works as follows:

### Prompt file with shell expansion

The scaffolded `.sandcastle/prompt.md` contains a shell expression:

```markdown
## Open issues

!`gh issue list --state open --label Sandcastle --json number,title,body,labels,comments --jq '...'`
```

The `!`` `` `` `` syntax marks a shell command to be evaluated **inside the sandbox** at the start of each iteration. `PromptPreprocessor.ts` runs these expressions and substitutes the output into the prompt text before it is delivered to the agent.

### Selection logic

The substituted prompt presents the agent with the live list of open issues and instructs it (in natural language) to:

- Work on **one issue per iteration**.
- Pick issues by priority: bug fixes → tracer bullets → polish → refactors.
- Skip issues blocked by other open issues.

The agent reads the list, reasons about priority, and picks one — there is no algorithmic selection in Sandcastle.

### Backlog manager variants

The `{{LIST_TASKS_COMMAND}}`, `{{VIEW_TASK_COMMAND}}`, and `{{CLOSE_TASK_COMMAND}}` placeholders in prompt files are replaced at scaffold time with the commands registered for the chosen backlog manager:

| Backlog manager   | List command                           | Close command                                             |
| ----------------- | -------------------------------------- | --------------------------------------------------------- |
| **GitHub Issues** | `gh issue list --label Sandcastle ...` | `gh issue close <ID> --comment "Completed by Sandcastle"` |
| **Beads**         | `bd ready --json`                      | `bd close <ID> "Completed by Sandcastle"`                 |

After the agent completes a task, it runs the close command itself (as instructed by the prompt).

---

## Orchestration Loop (`Orchestrator.ts`)

`orchestrate()` drives the iteration loop:

1. For each iteration (up to `maxIterations`):
   - Creates a worktree + starts the sandbox via `SandboxFactory.withSandbox()`.
   - Runs `withSandboxLifecycle()` which: configures git, runs `onSandboxReady` hooks (e.g. `npm install`), then calls `invokeAgent()`.
   - `invokeAgent()` builds the agent command via `provider.buildPrintCommand()` and streams output line by line.
   - Each output line is fed to `provider.parseStreamLine()`, which extracts text chunks, tool calls, and the session ID.
   - If the agent's output contains a **completion signal** (default `<promise>COMPLETE</promise>`), the loop exits early.
   - After the agent finishes, `SandboxLifecycle` collects new commits (`git rev-list`), merges the branch back to HEAD (for merge-to-head mode), and cleans up the worktree.

2. Returns `OrchestrateResult` with all iteration results, commit SHAs, and the branch name.

---

## Module Dependency Summary

```
cli.ts
  └─ InitService.ts        (scaffold, templates, Dockerfile generation)
  └─ DockerLifecycle.ts    (buildImage, startContainer, removeImage)
  └─ PodmanLifecycle.ts

run.ts
  ├─ PromptResolver.ts     (read prompt file or inline)
  ├─ EnvResolver.ts        (.sandcastle/.env → env map)
  ├─ mergeProviderEnv.ts   (merge agent/sandbox/host env)
  ├─ WorktreeManager.ts    (git worktree create/remove)
  ├─ SandboxFactory.ts     (worktree + sandbox lifecycle, SandboxConfig)
  │    └─ startSandbox.ts  (bind-mount vs. isolated dispatch)
  │         ├─ DockerLifecycle.ts / PodmanLifecycle.ts  (startContainer)
  │         ├─ syncIn.ts   (git bundle → sandbox clone)
  │         └─ CopyToWorktree.ts (copy host paths into worktree)
  └─ Orchestrator.ts       (iteration loop, invokeAgent, completion detection)
       └─ SandboxLifecycle.ts  (git setup, hooks, commit collection, merge-back)
            └─ syncOut.ts (format-patch / git am for isolated providers)
```
