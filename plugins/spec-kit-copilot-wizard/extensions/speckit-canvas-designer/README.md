# Spec Kit Canvas Designer

This extension is **under development and not ready for use**. It ships inside
the `spec-kit-copilot-wizard` plugin. Installing that plugin registers both the
Wizard and Designer canvases.

The provider's `contracts/` directory names the Wizard handoff and open input
(`wizard-handoff.mjs`, `host-open.mjs`), saved settings and save request
(`designer-settings.mjs`), configured Badge instances (`badges.mjs`) and
registered Badge definitions (`badge-definitions.mjs`), generation submission
and frozen request writer (`generation-request.mjs`), generated output status and
bounded folder/Open actions (`generated-output.mjs`), Specify version inventory (`specify-inventory.mjs`),
control adapter exports (`control-adapter.mjs`), and contribution field/schema
rules (`design-contributions.mjs`). The existing readers and handlers retain
filesystem confinement, UI lifecycle, and revision conflicts. The generator is
independently packaged and validates request integrity with its own
`scripts/contracts/generation-request.mjs`; it does not import the provider.
The browser's matching mount, readiness, and draft-change rules live in
`ui/control-adapter-contract.js`, served with the provider rather than loaded
from a preset.
The browser-safe `ui/generated-output-state.js` defines status, reveal, Generate,
Open, and error response shapes shared by the server and browser. Reveal responds
with the folder actually opened: the extensions parent before generation, or
the verified canvas target once present.
The browser and provider import the same `ui/generation-state.js` definitions
for pending and duplicate-ID errors; the browser loads that asset through the
authenticated shell. An unavailable Generate skill takes precedence over a
duplicate saved ID, so the duplicate-ID click exception cannot mask a missing
capability.

For local UX inspection, the project skill `speckit-designer-preview` opens the
official Designer canvas with `{preview:true}`. It shows an illustrative Badges
tab with sample phases and output paths, without a Wizard handoff or Specify
installation. The banner marks the session as a preview; Save and Generate are
unavailable in both the UI and HTTP API. Edits are ephemeral and do not verify
template composition, project setup, or the published hosted package.

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
`speckit-extension-canvas-design-load-page` skill checks every explicitly
declared template against one `specify artifact list --json` inventory before opening Designer. It opens the
official provider once with the complete typed inventory of page names,
paths, asset kinds and replacement strategies.
Preset and project overrides are honored. The provider obtains a fresh inventory
at open and checks submitted names and paths against the active layers. Failed CLI resolution, incomplete
page lists, unsafe paths and invalid handoffs fail opening. A resolved page whose winning file is missing or unreadable prevents opening;
invalid JSON in a readable page appears as a marked tab with its template
name, path and reason so the user can troubleshoot with the agent.
If the installed Canvas Design page schema itself is missing or unusable,
Designer does not open and reports the schema path with repair guidance;
individual page errors still appear as tabs once the schema loads.

Essentials requires Canvas ID and Title from the resolved core page. Description,
Workflow header, and Allow custom artifact directory slug are ordered Essentials contributions.
Header logo, Main page logo, and light/dark accent, page background, surface,
secondary surface, and text colors are ordered Appearance contributions
registered by the composed load-page command. The two required identity fields
use the fixed Designer identity control; Badges uses its fixed page shell with
registered badge input control definitions and Designer adapters. Output evidence
is nonvisual host data, not a Designer page. Other fields use registered adapters: `stock.checkbox`
provides the optional boolean editor, and `stock.text` validates optional text
and palette values at Generate. Generate packages the winning stock-text generated adapter
for visible Description, Workflow header, or read-only text placements. Text
fields on a page or in a contribution can opt into `"required": true`; the
shared text validator rejects blank or whitespace-only values at Generate,
while Save can keep an incomplete draft.
Canvas ID and Title remain unconditionally required, and other text fields
remain optional unless configured otherwise. The current generated canvas
allows an optional artifact directory slug for each new workflow when
Essentials' default-off Allow custom artifact directory slug option is enabled. Otherwise Spec Kit
chooses the directory. The optional Show
setup checkbox follows the stock control pattern without delegating project
setup to adapter code. The Appearance's optional image controls upload, preview, replace,
and remove independent PNG,
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
Header logo, the existing brand mark remains unchanged. Without optional text fields, generated description and heading default to
`Spec Kit workflow canvas.` and `Workflows`.

Preset-generated pages can publish ID-only slots and receive any registered
`stock.image` field by `generatedBinding.page` and `.slot`, independent of the
field's Designer page. The renderer places a `data-asset-slot` element where it
wants the image; the generated host matches the ID and mounts the packaged asset.
Missing and duplicate placements fail explicitly. The generated host
supplies an authorized URL and mount node to the packaged image adapter, which
is shared across Header, Main, and preset placements. An absent Header logo
retains the brand mark; a configured image with a failing adapter reports a
visible error rather than falling back.

The required generated Workflow page declares named slots and a replaceable
`generated.workflow-page-adapter` for its whole-page presentation. Designer
validates and freezes the required `workflow.phases` placement, plus separately
registered typed field placements targeting that page or a preset-added page.
The stock page adapter renders the workflow collection, summary, setup,
constitution, phase composition, and additional Workflow contribution slots;
a replacement adapter controls their presentation rather than inheriting a
host-owned contributions area. Preset-added page renderers expose
`data-field-slot` targets. The generated host retains authorized actions,
persistence, and shared navigation. Designer's own tabs, settings UI, and
control model are unchanged. Read-only values remain the default; explicit
editable generated values use the generated shell's existing typed value API,
while packaged images are display-only.

Workflow name appears in the generated canvas's workflow collection, before
phase navigation, while creating a workflow. It labels the workflow there.
When Allow custom artifact directory slug is on, the generated workflow accepts an optional
Artifact directory slug. If entered, it previews the View target; the created
directory, which may include a numeric prefix, remains authoritative.
Wizard-inferred output evidence remains in the handoff and frozen generation
data without an Outputs page. Badge input controls may declare additional
Markdown files that a phase is expected to produce when inference missed them.
They appear as additional output links and are available as badge evidence,
without changing the inferred default View target.
A phase without an inferred viewer stays without a View button even when
a badge watches a file. Constitution still opens
`.specify/memory/constitution.md`. The **Generate** tab is fixed shell
UI rather than a customizable contribution, so it does not register a JSON
definition or adapter/renderer template pair.
The existing header Save persists confirmed output evidence with the other bounded,
structurally valid drafts, including incomplete field values, to `settings.json`
beside the handoff in the Designer session artifacts (never to the page templates);
reopening the same handoff retains the saved revision but starts a fresh form
from template defaults when its resolved pages are unchanged. Saved additional
files and legacy viewer selections are not restored on reopen; a subsequent Save
or Generate replaces them with the handoff defaults.
Appearance's optional `RRGGBB` or `#RRGGBB` palette fields use `stock.text`;
blank retains the current color in that mode, while invalid hex blocks Generate
without preventing an incomplete draft from being saved. The generated canvas
keeps its existing light/dark toggle. Designer's fixed header also has a
keyboard-accessible light/dark toggle, stored in the browser for page refreshes;
it follows the system contrast preference until explicitly changed. There is
no Designer color preview or contrast warning. The Designer connection pill
reports Live when the current provider responds and Disconnected when a
bounded health check fails; the check does not replace the panel or discard
unsaved drafts. A transient interruption notice clears when the connection
recovers, without clearing unrelated errors or accepted Open guidance.
An output-status lookup error is shown on the page without marking a responsive
provider disconnected or removing the editable form.
The 10-second liveness probe fetches a small authenticated
stylesheet; every sixth probe also refreshes the full generation availability
state. The server remains authoritative at Generate if availability changes
between polls. If the provider URL is dead, closing and reopening the panel
from Copilot is still necessary.
Generate freezes the combined artifact links into the app: its phase card links
to each listed file and View artifact opens the selected default. A phase with no
inferred artifacts remains empty unless a link is added.
Appearance remains empty by default.
Preset-registered stock text and checkbox fields mount their shared adapters
in their declared Designer page slot and are saved alongside required values. A registered
`shared.control-definition` for a typed object or image field must reference both a
`designer.control-adapter` and `generated.control-adapter` replace-only template. Both modules
export `mount`, `controlId`, and a matching `valueContract`; Designer adapters also
export pure `validate(value, field): boolean` and return an `isReady()` handle from
`mount({ root, field, value, onChange })`. Each adapter belongs
to one control definition; multiple fields may reuse that control. Fields
resolve their unique `shared.control-definition` by the field's `control` ID.
An optional `requires` entry must name that same definition; Generate packages
the resolved, validated definition and its paired adapter. The Designer
mount receives the field, draft value, and change callback; the generated
mount receives the frozen value and displays it read-only in the declared
`details.content` slot. Missing, wrong-kind, non-replace, or multiply owned
control assets stop Designer opening rather than falling back to a stock input.
A separately registered generated-host page definition
and replace-only renderer add a page only to the generated app, not Designer's
tabs. The provider verifies the executable Specify template stack (and rejects
native script registrations), checks module syntax and declared exports without executing
the bytes in Node, and rechecks Designer adapters before serving captured bytes.
Changed assets require reopening Designer. The Designer document's CSP allows
same-origin scripts, API calls, and styles, plus same-origin images and data-URL
previews for stock-image controls, but blocks ordinary cross-origin
requests from adapters; it does not sandbox approved adapter code.
The browser reports non-function
`mount` exports, incompatible `controlId` or `valueContract` exports, and mount
failures beside the affected control. Callbacks from controls removed during a
tab change cannot overwrite the current draft. It validates the page/renderer pair and freezes
their bytes for packaging without the originating preset. Module dependencies
in generated renderers are rejected because only the renderer is packaged.
Registered `generated.value-definition` JSON templates join the same field-ID collision
registry and declare a typed constant or a workflow-scoped computed value.
Constants may be read-only, runtime-editable, or processing-only; computed values
may be read-only or processing-only, never runtime-editable. A computed value must
have its own replace-only `generated.computed-value-provider` `.mjs` registration with a direct
`export function provideValue` or `export const provideValue` declaration
(`export { provideValue }` and imports are unsupported). The function receives
`{ workflow: { id, slug, label } }` for the selected workflow and must return
a synchronous, JSON-serializable value matching the definition's typed schema.
Async functions and non-function exports fail visibly during generated-canvas
refresh; Designer checks syntax but does not execute providers. Generate
confirms each resolved provider's
name, source and hash before freezing its bytes for packaging. Changes since
Designer opened require reopening and reconfirming. Generated pages may declare
the IDs they consume in `values`. The packaged app rejects changed provider
bytes before execution; this is not a sandbox for approved provider code.
Runtime-editable values belong to the generated canvas shell, not to a
particular workflow's drafts.
Save rejects stale revisions and malformed draft shapes, but accepts incomplete
field values and reports failures without discarding edits. **Generate canvas**
first saves the current draft with the same revision check, validates all
enabled fields, then freezes and dispatches a file-creation-only request to the
child-session agent. A brief **Submitting...** lock ends when the request is
acknowledged, before the child agent begins; later dispatch failures are
reported in the session log, not the already-sent HTTP response.
The server requires the submitted snapshot to match that saved revision and
freezes the saved values, outputs, and badges rather than trusting a second copy.
The Designer stays editable while creation continues. An authenticated output
status check verifies the matching config, provenance, and final entry point
before reporting **Canvas files created.** Superseded status checks cannot replace
the current Canvas ID's status or error. A second click during submission is
blocked, but Generate can dispatch again while awaiting the child-session agent
if its first attempt stalls. If an earlier non-replacement request publishes
after a retry is accepted, its verified output remains openable even if the
newer request fails. Inspect the child-session chat before retrying.
These local checkout and session-artifact checks reject unsafe links and
metadata; they do not coordinate with another local process replacing ordinary
directories while Designer is using them. Avoid concurrent edits to these
folders during Generate or Open.
Reopening starts with template defaults while retaining the saved revision.
Generation requires both separate Generate and Open skills and a complete
Wizard handoff; a hosted package with only the older combined Generate command
is blocked rather than silently reloading Designer.
For a verified same-handoff target, **Regenerate canvas** confirms that all
files, including manual edits, will be overwritten. The generator stages and
validates replacement, then swaps directories with rollback; foreign or
incomplete output is not replaceable. The server rejects replacement fields
when the target is absent; creation must be submitted without replacement,
and replacement requires the matching verified prior request ID. If a target
appears before creation, review it and confirm regeneration when it belongs
to this handoff, or save a different Canvas ID. The target-folder link reveals
`.github/extensions/` until the generated folder exists, and reveals
the generated folder afterward.
**Open canvas** is available only after the generated files are verified.
An accepted regeneration waits for its own verified output before enabling
Open or Share, so the previous published version cannot disconnect Designer
while replacement is pending. If regeneration fails or stalls, reopen Designer
to clear that panel-local wait and recheck the previously published files.
Before dispatch, the Open step warns that registration disconnects Designer
and shows the child-chat guidance. Generate and Open stay disabled after the
opening request is accepted; an error before acceptance restores them. The
child-session command reloads extensions, verifies the exact project provider,
and opens its canvas. Reopen Designer to continue editing after registration;
the child chat reports success or failure and can retry opening existing files
without regenerating. There is no supported provider-initiated panel-close operation.
Sharing remains optional instructions for a team project extension, a personal
extension, or a plugin; no distribution happens automatically. The Share commit
path appears only for the current Canvas ID's verified output when no
regeneration is pending; otherwise the page asks for generation and verification.
At Generate, Designer checks the child checkout's Specify inventory for packages
in the Wizard handoff and freezes their installed versions alongside the original
Wizard snapshot. Unrelated installed packages do not affect version verification.
Version drift is reported as a warning rather than blocking generation. If
Specify's inventory cannot be read or a package is missing, that package's
generated version is marked `unverified` and the warning remains visible.
Pages explicitly marked `enabled: false` are omitted even if their other fields
are malformed; unreadable pages still show errors because their enabled state
cannot be determined.
A missing skill directs users to relaunch with the current Canvas Design release or the
current local source, before any generation request is prepared. Healthy pages remain
editable even when another page fails. Essentials
is selected first, including when it shows an error; in that case it supplies
no Canvas ID or Title values, so Generate remains unavailable. When a partial non-preview composition has no pages, Designer explains that
no settings pages are registered and Generate remains unavailable. Tab changes display the in-memory model without re-resolving
pages; there is no page-reload control or persisted page snapshot. After a
successful handoff launch, the provider saves its complete resolved open
inventory in the Designer session's `speckit-canvas-designer/last-open.json`.
Restarting Designer in that same session with no input restores the most recent
successful handoff and revalidates its pages and templates, but starts a fresh
editable form rather than rehydrating saved values.
An invalid saved inventory or missing handoff fails explicitly rather than
opening a blank shell; an explicit launch can repair the saved inventory.
Replacement saves the new inventory only when the open succeeds; if closing
the previous server fails or the panel closes while replacement is pending,
the prior inventory is restored and the new shell is closed. A concurrent
empty-input open waits for that decision rather than reading a staged record.
Opening `speckit-canvas-designer` without input before any successful handoff
launch still shows an empty shell. A different session cannot reuse this
session's handoff or resolved inventory. Panels opened before this restore
feature was installed have no `last-open.json`; launch once with the original
complete resolved input to establish it.

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

Canvas Design's [taxonomy, kind-named JSON Schemas, and executable module contracts](../../../../spec-kit-extensions/extension-canvas-design/README.md#template-taxonomy-and-schemas)
define the registration and authoring surface. Required and added Designer tabs
share the `designer.tab-definition` kind and schema; the required tabs are identified
by their registered names. Preset fixture JSON omits `$schema` because its
installed package cannot reliably resolve a relative path into a separately
installed extension; see the mapping in the extension README.
