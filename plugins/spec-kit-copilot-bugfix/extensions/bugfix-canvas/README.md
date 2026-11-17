# Bug Fix Triage Pipeline

The `bugfix-canvas` Copilot App extension provides a generated dashboard for
the Spec Kit `bug` extension's assess, fix, and test phases. It lists bugs and
displays phase progress, severity, verdict, fix status, and test result badges.
Artifacts are read from `.specify/bugs/<slug>/`.

## Open and use

Install `spec-kit-copilot-bugfix` from the plugin marketplace, then ask Copilot
to open **Bug Fix Triage Pipeline**. The canvas can create or select a bug,
send phase work to the agent, and browse the resulting artifacts. Deleting a
bug through the canvas asks for confirmation before removing its directory.

The generated canvas exposes `run_phase`, `report_workflow_slug`,
`report_phase_artifact`, and `report_autopilot_step` actions. The previous
hand-written canvas's `list_bugs`, `setup_bug`, `run_stage`, and
`clarify_item` actions are not part of this replacement.

## Project setup

The **Set up project** button initializes Spec Kit in Copilot skills mode when
needed, then asks for confirmation before installing:

- The bundled `bug` extension, version `1.0.0`, enabled at priority `10`.
- The published `copilot-sub-agents` preset, version `1.0.0`, enabled at priority `1`.

Setup verifies both packages and reloads the phase skills before enabling the
workflow. The bundled `bug` version must match the configured version, so a
Specify CLI release bundling a different version needs a compatible package
recipe. Specify 1.4.0 also removes the preset's `speckit.taskstoissues` base
command, which causes composition warnings.
If Specify is missing or older than 1.0.7, selecting setup asks the agent to
install or upgrade it; opening the canvas does not.

The canvas requires the GitHub Copilot App, Node.js 22 or later, and Specify CLI
1.0.7 or later. Workflow state is stored in the Copilot session workspace;
bug artifacts remain in the project.

## Package

`extension.mjs` registers the canvas and its actions. `canvas-config.json`
defines its phases, package setup, assets, and badges; `runtime.mjs`,
`server.mjs`, and `setup.mjs` provide the generated host. The `contracts/`,
`pages/`, `controls/`, `buttons/`, `dialogs/`, `badges/`, and `ui/`
directories contain the packaged contracts and renderers.
`copilot-extension.json` retains the extension manifest for sharing and
installation. The setup source and minimum CLI version are adapted for this
plugin rather than the original generated worktree.
