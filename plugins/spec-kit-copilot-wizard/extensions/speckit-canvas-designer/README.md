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
Workflow header, Allow custom slug, Header logo, and Main page logo are separate
ordered stock contributions registered by the composed load-page command. The
two required fields stay fixed but mount the same registered `stock.text`
Designer adapter as optional text fields. `stock.checkbox` similarly provides
the optional boolean editor. Their field-specific resolved rules come from approved declarations; the
adapter validates the values at Generate. Generate packages the winning stock-text generated adapter
for visible Description, Workflow header, or read-only text placements. Text
fields on a page or in a contribution can opt into `"required": true`; the
shared text validator rejects blank or whitespace-only values at Generate,
while Save can keep an incomplete draft.
Canvas ID and Title remain unconditionally required, and other text fields
remain optional unless configured otherwise. The custom-slug boolean is
consumed by the generated shell, so it needs no
generated visual adapter or display toggle. A future Setup confirm checkbox
can follow this pattern without delegating project setup to adapter code. The
optional image controls upload, preview, replace, and remove independent PNG,
JPEG, GIF, or WebP images up to 32 KiB each. Rejected files show an accessible
reason beside their picker, including the actual size when over the limit;
successful replacement or removal clears the message. A failed upload blocks
Save, Generate, and tab departure until retry or explicit cancellation. All image fields,
including preset-owned asset slots, require the same resolved `stock.image`
definition and paired adapters; the Designer adapter validates images for
Generate and renders the picker and preview. Both adapters receive an
image-source string as `value`; only the generated adapter receives
presentation `context` for packaged alt text and styling. The smaller Header
logo replaces the generated header's brand mark; the larger Main page logo appears beside the
workflow heading. Either can be set alone. Both use the shared field/slot
validation path and freeze the selected bytes and hashes at Generate. With no
Header logo, the existing brand mark remains unchanged. Without optional text
fields, generated description, heading and custom slug default to
`Spec Kit workflow canvas.`, `Workflows` and off.

Preset-generated pages can publish ID-only slots and receive any registered
`stock.image` field by `generatedBinding.page` and `.slot`, independent of the
field's Designer page. The renderer places a `data-asset-slot` element where it
wants the image; the generated host matches the ID and mounts the packaged asset.
Missing and duplicate placements fail explicitly. The generated host
supplies an authorized URL and mount node to the packaged image adapter, which
is shared across Header, Main, and preset placements. An absent Header logo
retains the brand mark; a configured image with a failing adapter reports a
visible error rather than falling back.

Workflow name appears after Phase input in the generated canvas's first
workflow-creation phase and labels the workflow there. Essentials' default-off
Allow custom slug setting controls whether an optional Workflow slug
field appears below it. The slug previews the View target directory; the created
directory remains authoritative.
Artifacts and Appearance are empty by default. Save persists bounded, structurally
valid drafts, including incomplete field values, to `settings.json`
beside the handoff in the Designer session artifacts (never to the page templates);
reopening the same handoff restores them when its resolved pages are unchanged.
Preset-registered stock text and checkbox fields mount their shared adapters
in their declared Designer page slot and are saved alongside required values. A registered
`shared.control-definition` for a typed object or image field must reference both a
`designer.control-adapter` and `generated.control-adapter` replace-only template. Both modules
export `mount`, `controlId`, and a matching `valueContract`; Designer adapters also
export pure `validate(value, field): boolean` and return an `isReady()` handle from
`mount({ root, field, value, onChange })`. Each adapter belongs
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
Registered `generated.value-definition` JSON templates join the same field-ID collision
registry and declare a typed constant or a workflow-scoped computed value.
Constants may be read-only, runtime-editable, or processing-only; computed values
may be read-only or processing-only, never runtime-editable. A computed value must
have its own replace-only `generated.computed-value-provider` `.mjs` registration with a direct
`export function provideValue` or `export const provideValue` declaration
(named re-exports are unsupported). Designer validates the actual declaration
and checks that the transformed script parses,
but does not execute providers; Generate confirms each resolved provider's
name, source and hash before freezing its bytes for packaging. Changes since
Designer opened require reopening and reconfirming. Generated pages may declare
the IDs they consume in `values`. The packaged app rejects changed provider
bytes before execution; this is not a sandbox for approved provider code.
Runtime-editable values belong to the generated canvas shell, not to a
particular workflow's drafts.
Save rejects stale revisions and malformed draft shapes, but accepts incomplete
field values and reports failures without discarding edits. Generate invokes the
approved Designer adapter validator and freezes fields on every enabled page
while requiring non-reserved Canvas ID and Title on Essentials, and dispatches the
installed Canvas Design generate command to create a new source-owned
workflow canvas. Generate is unavailable if the Wizard handoff is incomplete,
Essentials is missing or invalid, any enabled page is invalid, or the Generate
skill is not installed in the child checkout.
A missing skill shows how to relaunch with Canvas Design v0.1.18 or the current
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

Canvas Design's [taxonomy, six kind-named JSON Schemas, and executable module contracts](../../../../spec-kit-extensions/extension-canvas-design/README.md#template-taxonomy-and-schemas)
define the registration and authoring surface. Required and added Designer tabs
share the `designer.tab-definition` kind and schema; the required tabs are identified
by their registered names. Preset fixture JSON omits `$schema` because its
installed package cannot reliably resolve a relative path into a separately
installed extension; see the mapping in the extension README.
