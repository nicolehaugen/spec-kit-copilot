# Spec Kit Canvas Designer

This extension is **under development and not ready for use**. It ships inside
the `spec-kit-copilot-wizard` plugin. Installing that plugin registers both the
Wizard and Designer canvases.

The Wizard hands approved customizations to a separate child session. That
session initializes Spec Kit in Copilot skills mode if needed, installs the
released `extension-canvas-design` package, approved Designer selections, and
the Wizard's active runtime presets, extensions and bundles through the Spec Kit
skills. It restores the runtime preset/extension priorities recorded by the
Wizard and verifies IDs, versions, enabled states and priorities before opening
Designer; unreproducible packages fail launch rather than being omitted. Local
development selections may override a hosted package only if the frozen runtime
identity, version and priority remain reproducible. The child reloads skills
once after installation. The composed
`speckit-extension-canvas-design-load-page` skill resolves every effective
template with `specify preset resolve` before opening Designer. It opens the
official provider once with the complete set of page names and paths.
Preset and project overrides are honored. Failed CLI resolution, incomplete
page lists, unsafe paths and invalid handoffs fail opening. A resolved page
whose file is missing or invalid instead appears as a marked tab with its
template name, path and reason so the user can troubleshoot with the agent.
If the installed Canvas Design page schema itself is missing or unusable,
Designer does not open and reports the schema path with repair guidance;
individual page errors still appear as tabs once the schema loads.

Essentials displays Canvas ID, Title, Description and Workflow header from the
resolved template. Workflow name appears after Phase input in the generated
canvas's first workflow-creation phase and labels the workflow there. Essentials'
default-off Allow custom slug setting controls whether an optional Workflow slug
field appears below it. The slug previews the View target directory; the created
directory remains authoritative.
Artifacts and Appearance are empty by default. Save persists validated field values to `settings.json`
beside the handoff in the Designer session artifacts (never to the page templates);
reopening the same handoff restores them when its resolved pages are unchanged.
Save rejects stale revisions and invalid values, and reports failures without
discarding edits. Generate freezes valid Essentials values and dispatches the
installed Canvas Design generate command to create a new source-owned
workflow canvas; the button is unavailable without a complete Wizard handoff,
a valid Essentials page, or the installed Generate skill in the child checkout.
A missing skill shows how to relaunch with Canvas Design v0.1.4 or the current
local source, before any generation request is prepared. Healthy pages remain
editable even when another page fails. Essentials
is selected first, including when it shows an error; in that case it supplies
no Canvas ID or Title values, so Generate remains unavailable. Tab changes display the in-memory model without re-resolving
pages; there is no page-reload control or persisted page snapshot. Reopening
with the same handoff ID reads and validates the pages again. Opening `speckit-canvas-designer`
without input (or with `{}`) still shows an empty shell.

A supplied `handoffId` must match the bounded handoff ID pattern; the provider
checks the handoff structure, fingerprint, size, and session-artifact boundary.
A missing or invalid handoff is an error, not an empty shell. The HTTP shell
binds to loopback and requires an unguessable URL token.

Run the provider tests with:

```bash
node --test plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/test/provider.test.mjs
```
