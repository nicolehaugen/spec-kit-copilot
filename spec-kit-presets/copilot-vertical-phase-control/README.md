# Copilot Vertical Phase Control

This Specify preset replaces the generated Canvas Design Workflow page's phase
adapter with a vertical, numbered step list and a Copilot Autopilot action.
The Wizard and Designer do not gain a new appearance setting: select this preset
alongside `extension-canvas-design` before Generate. The generated app packages
the selected adapter and its managed-run phase-control definition, and runs
without the design-time preset installed.

In local development, add it from this checkout using
`specify preset add --dev ./spec-kit-presets/copilot-vertical-phase-control`.
After its versioned release is published, register the repository's preset
catalog with `--install-allowed` and use
`specify preset add copilot-vertical-phase-control`.

Each step can be started manually. Autopilot runs the installed skills in order
in the workflow's own nested session and worktree; the host validates reported
outputs before accepting the next step. Other workflows can run in their own
children concurrently. Stop a running child from that session's Copilot chat,
not from the parent canvas. A failed or missing output blocks that workflow
for an explicit retry; the same child/worktree is reused for its later phases.
Project Constitution runs separately and cannot change during active workflow
runs. The default generated app retains its horizontal control when this
preset is not selected.
After a generated app restart, inspect the child chat and artifacts before
retrying an unfinished run; verified steps are not replayed. An active
Autopilot workflow cannot be deleted until it finishes or is resolved.
The managed-run capability is declared in the preset's phase-control JSON and
frozen into generated configuration. The server verifies both packaged hashes
without executing the browser module.
The replacement control also declares the phase-card and output badge slots,
so Designer badge placements remain available with the vertical layout.

This preset depends on the Copilot Canvas Design runtime and its Copilot
session APIs. Its packaged adapter requires `workflow.rows.v1` and
`workflow.managed-run.v1` host capabilities; a generated host missing either
reports an incompatibility instead of silently omitting Autopilot. It is not
a general-purpose Specify layout preset. Its catalog archive URL only becomes
usable when the versioned preset release is published.
