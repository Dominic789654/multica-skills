# Multica Skills

Public collection of Multica/Codex skill definitions used for research writing, paper review, figure planning, and draw.io diagram work.

## Contents

Skills live under `skills/<skill-name>/`. Each skill keeps its original `SKILL.md` plus any supporting `references/`, `examples/`, `scripts/`, or `shared/` files needed by that skill.

Included skills:

| Skill | Purpose |
| --- | --- |
| `benchmark-paper-template` | Structure benchmark and evaluation papers. |
| `figure-designer` | Design or audit core technical paper figures. |
| `idea-evaluator` | Evaluate preliminary research ideas. |
| `intro-drafter` | Draft structured Introduction logic for technical papers. |
| `openspec-agent-sdd` | Drive OpenSpec spec-driven development end to end from an autonomous agent. |
| `pre-submission-reviewer` | Run pre-submission paper checks. |
| `souldraw` | Plan, create, and edit draw.io / mxGraph diagrams. |
| `tech-paper-template` | Build a technical paper skeleton and consistency check. |
| `vibe-research-workflow` | Guide AI-assisted research workflows. |

## Importing

Use the skill directory URL or copy a folder from `skills/` into the target runtime's skill directory.

For Multica, import individual skills from their GitHub folder URL when supported by the CLI or UI.

## Scope

This repository intentionally excludes:

- Runtime/system skills from `.system/`.
- Generated caches such as `__pycache__/` and `.pyc` files.
- Private local-operation skills that expose machine aliases or local paths.
- Platform skills that already point to unrelated public upstream repositories.

`fireworks-tech-graph` was not included in this initial snapshot because `multica skill get` and `multica skill files list` timed out for that skill, and no local source directory was available in this workspace.

## License

No repository-wide license is declared yet. Individual skills may include their own license metadata in `SKILL.md`; preserve those notices when copying or modifying a skill.
