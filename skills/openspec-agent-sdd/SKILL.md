---
name: openspec-agent-sdd
description: Use when an autonomous coding agent (no human in the loop) needs to drive OpenSpec spec-driven development end-to-end — bootstrap, propose, implement, and archive a change without slash commands or interactive prompts. Triggers on "用 openspec 自主开发", "agent-own spec-driven dev", "openspec 无人值守 / 非交互", "spec-driven 自动跑一遍", "openspec init/propose/apply/archive 全自动", "drive OpenSpec from an agent". Captures the verified non-interactive CLI loop, the status/instructions state machine, the substitutions for OpenSpec's built-in "ask the user" stops, and validation-driven self-correction.
---

# OpenSpec Agent-Own Spec-Driven Development

Drive [OpenSpec](https://github.com/Fission-AI/OpenSpec) (`@fission-ai/openspec`) from an autonomous agent, with **no human in the loop and no slash commands**. OpenSpec's `/opsx:*` slash commands are not features for humans — they are procedural scripts written *for an agent* (they live in `.claude/commands/opsx/*.md` and `.claude/skills/openspec-*/SKILL.md` after init). An agent can skip them and call the underlying CLI directly, because the CLI is `--json`-first: **its first consumer is an agent, not a person.**

This skill is the distilled, hands-on-verified loop (tested against openspec 1.3.1, Node 22). Everything below was confirmed by actually running it, not just reading docs.

## Mental model: the CLI is a state machine

- `openspec status --change <name> --json` is the **state machine**: it returns each artifact's `status` (`ready` / `blocked` / `done`), its `missingDeps`, and `applyRequires` (the artifacts that must be `done` before implementation).
- `openspec instructions <artifact|apply> --change <name> --json` is the **per-step instruction source**: it tells you what to read (`dependencies` / `contextFiles`), what to write (`template`, `instruction`), and where (`resolvedOutputPath` / `outputPath`).
- `openspec validate --strict` is the **self-correction oracle**: errors are precise and machine-actionable (e.g. `ADDED "X" must include at least one scenario`), so the agent fixes and retries instead of stopping.

Loop = `init` (once) → `new change` → drive artifacts off `status`+`instructions` → write files → `validate` → mark tasks → `archive`.

## The non-interactive loop (copy/adapt)

### Step 0 — bootstrap (once per project)
`openspec init` is **interactive by default** (it prompts which AI tools to wire up) and will hang an unattended agent. Always pass `--tools`:

```bash
npm install -g @fission-ai/openspec@latest   # Node >= 20.19.0
cd <project>
openspec init --tools claude     # or: all | none | comma-list (cursor,codex,...). --force to auto-clean legacy files
```

Creates `openspec/specs/` (source-of-truth specs), `openspec/changes/`, and the agent scripts under `.claude/`.
For an **existing** OpenSpec project, don't re-init — run `openspec update` (regenerates AI instructions / refreshes commands); `openspec config profile` switches core vs expanded profile.

### Step 1 — create a change (already non-interactive)
```bash
openspec new change <kebab-name>     # derive the name yourself from the task/issue; add --schema only if non-default
openspec status --change <kebab-name> --json
```
Default schema is `spec-driven`: `proposal → specs → design → tasks`. Parse `applyRequires` and the per-artifact `status`/`missingDeps`.

### Step 2 — generate artifacts in dependency order
Loop while any artifact is `ready`:
```bash
openspec instructions <artifact-id> --change <kebab-name> --json
```
Read every file in `dependencies`, write the artifact to `resolvedOutputPath` using `template` as the structure and `instruction` as guidance. **`context`/`rules` are constraints for you — never copy them into the output file.** Re-run `status` after each write; stop when all `applyRequires` artifacts are `done`. The delta-spec format the `specs` artifact expects:

```markdown
## ADDED Requirements

### Requirement: <name>
The system SHALL <behavior>.

#### Scenario: <name>
- **WHEN** <trigger>
- **THEN** <expected outcome>
```
(`## MODIFIED / REMOVED / RENAMED Requirements` for the other delta kinds. Every requirement MUST have ≥1 `#### Scenario:` or `validate --strict` rejects it.)

### Step 3 — validate, then implement (apply)
```bash
openspec validate <kebab-name> --strict
openspec instructions apply --change <kebab-name> --json   # gives contextFiles + state + progress
```
Read all `contextFiles`, implement each task, and **flip `- [ ]` → `- [x]` in tasks.md immediately after each task**. `state` goes `ready` → `all_done` as tasks complete. Keep code changes minimal and scoped per task.

### Step 4 — archive (non-interactive) — auto-merges deltas into specs
```bash
openspec archive <kebab-name> -y     # -y skips confirmation; --skip-specs for doc/tooling-only; --no-validate (discouraged)
```
This is the closing of the loop: delta specs are **promoted into `openspec/specs/<capability>/spec.md`** and the change moves to `openspec/changes/archive/YYYY-MM-DD-<name>/`. (`changes` = proposals; `archive` merges them back into the truth库.)

## Agent-own substitutions for OpenSpec's "ask the user" stops

The shipped `/opsx:*` templates hard-code `AskUserQuestion` / "let the user select" pauses (in propose's requirement clarification, and in new/archive/verify change-selection). An unattended agent **must replace these**:

| Built-in stop | Agent-own substitution |
|---|---|
| "describe what you want to build" | derive intent from the issue/task description |
| "let the user pick the change" | one active change → auto-select; many → infer from context |
| non-critical ambiguity | make a reasonable default, record it in proposal/design, keep momentum |
| validation error | read the precise error, fix the artifact, re-run `validate` |
| **genuine** blocker (design conflict, missing critical info, hard error) | stop and escalate (in Multica: comment + @owner) — never guess |

Guiding rule from the templates: *"prefer making reasonable decisions to keep momentum."* Autonomy by default; escalate only on true blockers.

## Verified CLI quick reference

- State/instructions: `status --change <n> --json`, `instructions <artifact|apply> --change <n> --json`
- Discovery: `list [--specs] --json`, `schemas --json`, `show <item>`, `view`
- Lifecycle: `new change <n>`, `validate [item] --strict`, `archive <n> -y`
- Bootstrap/config: `init --tools <list>`, `update`, `config profile`
- Note: verb-first commands are canonical; `openspec spec ...` is **deprecated** → use `openspec show` / `validate --specs` / `list --specs`.

## Pitfalls (each cost a real run)

- Skipping `init` → no `openspec/` dir, every later command fails. It is step 0, not optional.
- Bare `openspec init` in automation → hangs on the tool prompt. Always `--tools`.
- Copying `context`/`rules` blocks into artifact files → pollutes output; they are instructions to you only.
- Forgetting `-y` on archive → waits for confirmation.
- A requirement without a `#### Scenario:` → `validate --strict` fails; the error names the exact requirement, so self-correct.
