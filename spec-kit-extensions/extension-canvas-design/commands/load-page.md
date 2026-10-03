---
description: Resolve registered Canvas Design templates and open the Designer once.
---

## Context

$ARGUMENTS supplies the Wizard `handoffId`. Work in this session's
project, not the Wizard's checkout. If the handoff ID is missing, ask for it;
do not guess or select another session's handoff.

## Pages

Load these default pages:

- Essentials (`canvas-settings-setup`)
- `canvas-settings-artifacts`
- `canvas-settings-appearance`

Use **Essentials** in progress messages and other user-facing descriptions of
the first page. `canvas-settings-setup` remains its stable template ID for
`specify preset resolve` and the Designer page input; do not rename the ID.

Presets may add pages in sections titled **Additional Designer pages** anywhere
in this command, including after the Steps. These additions extend the default
set; they do not run a second load operation.

The extension may list stock-field contribution JSON under **Canvas Design
templates**. Presets may list these and generated-host pages and modules under
**Additional Canvas Design templates** anywhere in this composed command.
Each registration declares its Canvas Design kind (`designer.field`,
`generated.page`, `generated.renderer`, `control.definition`,
`designer.adapter`, `generated.adapter`, `value.definition`, or
`value.provider`) and strategy (`replace`).
Designer pages have kind `designer.page` and strategy `replace` (implicit for
the extension's default page templates). A name must be a Specify template
in the manifest. The `canvas-design` tag and files on disk do not register
themselves. Control definitions, host-specific adapters, value definitions,
and provider modules must each be explicitly registered. `value.definition`
declares a typed constant or a workflow-scoped provider; a generated page
declares the value IDs it consumes in its `values` list. A processing-only value
is not automatically presented and is not secret from its declared consumers.
Providers are packaged, never evaluated by Designer.

## Canvas Design templates

- `canvas-stock-description` — `designer.field`, `replace`
- `canvas-stock-workflow-heading` — `designer.field`, `replace`
- `canvas-stock-custom-slug` — `designer.field`, `replace`

## Steps

1. Read this entire composed command first. Collect the defaults and every name
   in every **Additional Designer pages**, **Canvas Design templates**, and
   **Additional Canvas Design templates** section, removing duplicates.
   Record each declaration's kind and strategy. Conflicting kinds/strategies
   for a name are an error. Names must start with a lowercase letter and contain only lowercase letters,
   digits and hyphens (at most 80 characters). Keep pages separate from
   non-page templates; a name in both groups is an error.
2. Follow the `speckit-preset` skill to run `specify preset resolve <name>` for
   each name from the project root. Resolve the complete named inventory before
   opening Designer. Its order and winning files belong to Specify.
   Use Specify CLI >=1.0.7. Its human-readable output looks like:

       canvas-settings-setup: C:\project\.specify\extensions\extension-canvas-design\pages\essentials.json
         (top layer from: extension:extension-canvas-design v0.1.9)

   Ignore leading indentation and record the complete path following the exact
   `<name>:` prefix. Preserve spaces and drive-letter colons; do not split on
   every colon. If output wraps, rerun with a sufficiently wide `COLUMNS`
   environment setting rather than guessing a truncated path.
3. Inspect the output AND exit status. `not found` can return exit code 0.
   Stop on missing/ambiguous results, command errors, or a composition warning
   for any name. Never choose a file by scanning `.specify`, reconstruct
   precedence, or substitute an extension default. Appended instructions in
   this command are allowed; composing multiple complete JSON documents or
   appending executable JavaScript is not. For every registered name,
   inspect `specify artifact info template:<name> --json` and confirm that
   `kind` is `template` and every stack layer has `strategy: replace`
   (extension templates replace implicitly). For executable assets, also inspect
   `specify artifact info script:<name> --json`; an unknown-script error is
   expected, but a native script of the same name is unsupported. Reject
   `append`, `prepend`, or `wrap` asset registrations even if Specify
   resolved a path. Do not use metadata to choose or reconstruct the winner.
4. Only after every name resolves, open the official installed Copilot provider
   exactly once with the complete collected set:
   `open_canvas({canvasId:"speckit-canvas-designer",
   extensionId:"plugin:spec-kit-copilot-wizard:speckit-canvas-designer",
   instanceId:"designer-<handoffId>",input:{handoffId:"<handoffId>",
   pages:[{"name":"<page-name>","path":"<resolved-path>","kind":"designer.page","strategy":"replace"},...],
   templates:[{"name":"<asset-name>","path":"<resolved-path>","sourceId":"<Specify-reported-source-ID>","kind":"<declared-kind>","strategy":"replace"},...]}})`.
   Obtain each `sourceId` from that name's `top layer from:` metadata:
   map the exact versionless `project override` marker to `project`; for a
   preset or extension source, strip only its trailing ` v<version>` (for
   example, keep `copilot-billing-canvas` or
   `extension:extension-canvas-design`). Stop if neither form matches; do
   not infer the source from the file path. Use
   an empty `templates` array if none are registered. Submit all defaults,
   additional pages, and registered templates in this single call. The provider
   validates the handoff and complete inventory before returning a URL. A
   resolved page with invalid or missing file contents appears as an error tab
   with its path and reason; other pages remain available. Invalid or missing
   non-page contributions stop the open with an actionable error. Generated
   pages require a matching registered renderer and do not create Designer tabs. Do not
   substitute another provider or open if resolution failed.
   Confirm the `open_canvas` result matches the requested canvas ID, plugin
   extension ID, instance ID and `input.handoffId`; report a mismatch as a failure.
   A successful open means only that the shell is available, not that every
   page loaded or that generation is ready. Designer shows page-load errors to
   the user; do not use Playwright or inspect tabs after opening.

If resolution fails before step 4, report the CLI error/output and stop without
opening Designer. If opening fails, report the error unchanged; do not run a
Python helper or write the provider's state files yourself. Do not invoke a
page-loading action, manually reload, or re-resolve pages on tab changes.
