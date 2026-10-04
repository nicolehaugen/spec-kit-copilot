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
official provider once with the complete typed inventory of page names,
paths, asset kinds and replacement strategies.
Preset and project overrides are honored. Failed CLI resolution, incomplete
page lists, unsafe paths and invalid handoffs fail opening. A resolved page
whose file is missing or invalid instead appears as a marked tab with its
template name, path and reason so the user can troubleshoot with the agent.
If the installed Canvas Design page schema itself is missing or unusable,
Designer does not open and reports the schema path with repair guidance;
individual page errors still appear as tabs once the schema loads.

Essentials requires Canvas ID and Title from the resolved core page. Description,
Workflow header and Allow custom slug are separate ordered stock contributions
registered by the composed load-page command. With all three registered, the
same five controls appear in the same order. Without them, generated description,
heading and custom slug default to `Spec Kit workflow canvas.`, `Workflows` and
off. Workflow name appears in the generated canvas's workflow collection,
before phase navigation, while creating a workflow. It labels the workflow
there. Essentials'
default-off Allow custom slug setting controls whether an optional Workflow slug
field appears below it. The slug previews the View target directory; the created
directory remains authoritative.
Artifacts and Appearance are empty by default. Save persists validated field values to `settings.json`
beside the handoff in the Designer session artifacts (never to the page templates);
reopening the same handoff restores them when its resolved pages are unchanged.
Preset-registered stock text and checkbox fields render in their declared
Designer page slot and are saved alongside built-in values. A registered
`control.definition` for a typed object field must reference both a
`designer.adapter` and `generated.adapter` replace-only template. Both modules
export `mount`, `controlId`, and a matching `valueContract`. Each adapter belongs
to one control definition; multiple fields may reuse that control. The Designer
mount receives the field, draft value, and change callback; the generated
mount receives the frozen value and displays it read-only in the declared
`details.content` slot. Missing, wrong-kind, non-replace, or multiply owned
control assets stop Designer opening rather than falling back to a stock input.
A separately registered generated-host page definition
and replace-only renderer add a page only to the generated app, not Designer's
tabs. The provider verifies the executable Specify template stack (and rejects
native script registrations), checks module syntax and declared exports without executing
the bytes in Node, and rechecks Designer adapters before serving captured bytes.
Changed assets require reopening Designer. The browser reports non-function
`mount` exports, incompatible `controlId` or `valueContract` exports, and mount
failures beside the affected control. It validates the page/renderer pair and freezes
their bytes for packaging without the originating preset. Module dependencies
in generated renderers are rejected because only the renderer is packaged.
Save rejects stale revisions and invalid values, and reports failures without
discarding edits. Generate validates and freezes fields on every enabled page
while requiring non-reserved Canvas ID and Title on Essentials, and dispatches the
installed Canvas Design generate command to create a new source-owned
workflow canvas. Generate is unavailable if the Wizard handoff is incomplete,
Essentials is missing or invalid, any enabled page is invalid, or the Generate
skill is not installed in the child checkout.
A missing skill shows how to relaunch with Canvas Design v0.1.7 or the current
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

The provider loads without installed npm dependencies. The Wizard's environment
setup checks and installs the Designer's renderer parser alongside its own YAML
parser. Opening Designer directly without the parser reports an install instruction
instead of failing at provider startup. For local tests, install dependencies with
`npm ci` in this directory, then run:

```bash
node --test plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/test/provider.test.mjs
```
