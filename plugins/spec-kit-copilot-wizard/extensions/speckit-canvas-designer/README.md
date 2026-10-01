# Spec Kit Canvas Designer

This extension is **under development and not ready for use**. It ships inside
the `spec-kit-copilot-wizard` plugin. Installing that plugin registers both the
Wizard and Designer canvases.

The Wizard hands approved customizations to a separate child session. That
session initializes Spec Kit in Copilot skills mode if needed, installs the
released `extension-canvas-design` package and approved selections through the
Spec Kit skills, and reloads skills. The composed
`speckit-extension-canvas-design-load-page` skill resolves every effective
template with `specify preset resolve` and calls `speckit_designer_load_pages`
once with the complete set. Preset and project overrides are honored; missing
or invalid pages stop the load without replacing the last valid page model.
Only after the first successful load does the child open the Designer canvas.

Essentials displays Canvas ID, Title, Description, Workflow header and Show
slug field from the resolved template. Artifacts, Appearance and Result Badges
are empty by default. The controls are temporary; Save and Generate remain
disabled. Reload pages explicitly re-runs the composed skill and updates
open panels after a successful full-batch load. Opening
`speckit-canvas-designer` without input (or with `{}`) still shows an empty
shell.

A supplied `handoffId` must match the bounded handoff ID pattern; the provider
checks the handoff structure, fingerprint, size, and session-artifact boundary.
A missing or invalid handoff is an error, not an empty shell. The HTTP shell
binds to loopback and requires an unguessable URL token.

Run the provider tests with:

```bash
node --test plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/test/provider.test.mjs
```
