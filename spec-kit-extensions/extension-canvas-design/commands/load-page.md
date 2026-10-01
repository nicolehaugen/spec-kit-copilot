---
description: Resolve Designer settings pages and load them into the Canvas Designer.
---

## Context

$ARGUMENTS supplies the Wizard `handoffId`. Work in this session's
project, not the Wizard's checkout. If the handoff ID is missing, ask for it;
do not guess or select another session's handoff.

## Pages

Load these default pages:

- `canvas-settings-setup`
- `canvas-settings-artifacts`
- `canvas-settings-appearance`
- `canvas-settings-results`

Presets may add pages in sections titled **Additional Designer pages** anywhere
in this command, including after the Steps. These additions extend the default
set; they do not run a second load operation.

## Steps

1. Read this entire composed command first. Collect the defaults and every name
   in every **Additional Designer pages** section, removing duplicates. Page
   names must start with a lowercase letter and contain only lowercase letters,
   digits and hyphens (at most 80 characters).
2. Follow the `speckit-preset` skill to run `specify preset resolve <name>` for
   each name from the project root. Resolve all pages before submitting any.
   Use Specify CLI >=1.0.7. Its human-readable output looks like:

       canvas-settings-setup: C:\project\.specify\extensions\extension-canvas-design\pages\setup.json
         (top layer from: extension:extension-canvas-design v0.1.1)

   Ignore leading indentation and record the complete path following the exact
   `<name>:` prefix. Preserve spaces and drive-letter colons; do not split on
   every colon. If output wraps, rerun with a sufficiently wide `COLUMNS`
   environment setting rather than guessing a truncated path.
3. Inspect the output AND exit status. `not found` can return exit code 0.
   Stop on missing/ambiguous results, command errors, or a composition warning
   for a page. Never choose a file by scanning `.specify`, reconstruct precedence,
   or substitute an extension default. Appended instructions in this command are
   allowed; composing multiple complete JSON documents for a page is not.
4. Only after every page resolves, open the official installed Copilot provider:
   `open_canvas({canvasId:"speckit-canvas-designer",
   extensionId:"plugin:spec-kit-copilot-wizard:speckit-canvas-designer",
   instanceId:"designer-<handoffId>",input:{handoffId:"<handoffId>"}})`.
   The panel shows a loading state until the page set is validated. Do not
   substitute another provider or open a panel if resolution failed.
5. Call `invoke_canvas_action` exactly once on that instance with
   `actionName:"loadPages"` and
   `input:{handoffId:"<handoffId>",
   pages:[{"name":"<template-name>","path":"<resolved-path>"},...]}`.
   Submit the complete collected set, not individual pages. Report the action's
   result. Only a successful `loaded:true` result means Designer is ready.

If resolution fails before step 4, report the CLI error/output and stop without
opening Designer. If opening or loading fails, report the error unchanged;
do not run a Python helper or write the provider's state files yourself.
