# Copilot Vertical Phase Control

This Specify preset replaces the generated Canvas Design Workflow page's phase
adapter with a vertical, numbered step list and a Copilot Autopilot action.
The Wizard and Designer do not gain a new appearance setting: select this preset
alongside `extension-canvas-design` before Generate. The generated app packages
the selected adapter and runs without the design-time preset installed.

In local development, add it from this checkout using
`specify preset add --dev ./spec-kit-presets/copilot-vertical-phase-control`.
After its versioned release is published, register the repository's preset
catalog with `--install-allowed` and use
`specify preset add copilot-vertical-phase-control`.

Each step can be started manually. Autopilot asks the attached Copilot session
to run the installed skills in order; the host validates reported outputs
before accepting the next step. Stop or a failed/missing output leaves the
workflow pending for an explicit retry. Like the stock control, a manual retry
while a prior turn is pending may duplicate work; check chat first. Project Constitution remains a
separate, project-scoped action; the default generated app retains its
horizontal control when this preset is not selected.

This preset depends on the Copilot Canvas Design runtime and its Copilot
session APIs; it is not a general-purpose Specify layout preset. Its catalog
archive URL only becomes usable when the versioned preset release is published.
