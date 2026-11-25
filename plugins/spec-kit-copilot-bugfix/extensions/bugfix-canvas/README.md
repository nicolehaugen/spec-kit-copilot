# Bug Fix Pipeline

This Copilot App canvas runs the Spec Kit `bug` workflow through its generated
assess, fix, and test skills. It shows workflow progress, badges, and Markdown
artifacts for each bug.

| Phase | Skill | Artifact |
| --- | --- | --- |
| Assess | `speckit-bug-assess` | `.specify/bugs/<slug>/assessment.md` |
| Fix | `speckit-bug-fix` | `.specify/bugs/<slug>/fix.md` |
| Test | `speckit-bug-test` | `.specify/bugs/<slug>/test.md` |

## Setup

The generated host requires Specify CLI 1.0.7 or later and a project initialized
for Copilot skills. Its frozen setup recipe selects the `bug` extension at
version 1.0.2, enabled at priority 10. The portable default source resolves the
extension bundled with Specify; it does not point to a particular checkout.
Specify 1.4.2, used to generate this canvas, bundles the matching version.

When setup is needed, the canvas offers project initialization and then shows
the package plan for confirmation. It checks the installed package version,
settings, and phase skills before marking the project ready. A different Specify
release may bundle another `bug` version; in that case setup reports the
version mismatch rather than treating it as the frozen version.

## Local development

On Windows, from the repository worktree, the Copilot CLI supports loading this
plugin with `copilot --plugin-dir ".\plugins\spec-kit-copilot-bugfix"`. In the
Copilot App, open **Bug Fix Pipeline** using the plugin provider. Avoid loading the
separately generated project extension with the same canvas ID at the same
time.

The host resolves the active checkout from session metadata and stores runtime
state in the session workspace. Worktree changes do not update an installed or
published plugin automatically.

Run `node --test plugins\spec-kit-copilot-bugfix\tests\imported-canvas.test.mjs`
from the repository root to check the imported copy without installing packages.

## Agent actions

- `run_phase`: dispatch a phase using `phase` and `args`, with optional
  `itemId`, `slug`, and `name`.
- `report_workflow_slug`: report the actual directory slug for a phase run.
- `report_phase_artifact`: report an artifact path for a phase run.
- `report_autopilot_step`: start or complete a step in an Autopilot run.

This generated canvas replaces the previous `list_bugs`, `setup_bug`,
`run_stage`, and `clarify_item` actions. Callers of those actions must migrate.

`copilot-extension.json` supplies the extension identity for plugin discovery
and sharing. The generated definitions, adapters, runtime modules, and assets
are kept together; their checked contribution bytes must not be normalized.
