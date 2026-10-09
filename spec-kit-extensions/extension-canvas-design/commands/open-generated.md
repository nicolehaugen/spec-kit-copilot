---
description: Register and open an existing generated workflow canvas from a frozen Designer request.
---

## Context

$ARGUMENTS must supply the Designer handoff ID and frozen request ID sent by
the Open action. Run in that Designer child session and its checkout only.
This command opens an **existing** project extension; it never runs Generate,
replaces files, installs packages, or runs workflow phases. A reset or cleared
session does not prove that the project provider is registered.

## Steps

1. Obtain this session's absolute child checkout and `session.workspacePath`
   from session metadata. Accept handoff and request IDs only when they match
   `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`. If the frozen request at
   `<session.workspacePath>/speckit-canvas-designer/handoffs/<handoffId>/generations/<requestId>/request.json`
   remains available, read it with a bounded read, verify its SHA-256 integrity
   and matching IDs with `scripts/contracts/generation-request.mjs`, and require
   its `project` to equal this checkout. Resolve its exact
   `.github/extensions/<canvas-id>/` target, never an arbitrary path. A present
   but invalid request is an error, not an excuse to choose another app.
   For a reopen after reset/clear when the frozen request is unavailable,
   search only immediate child directories of this checkout's
   `.github/extensions/` for `settings-provenance.json` with *both* exact
   `handoffId` and `requestId`. Require one unique matching directory with a
   portable canvas ID. Do not infer the canvas ID from another session,
   an extension registry entry, or a stale Designer panel.
2. For the chosen directory, require the generated `extension.mjs`,
   `canvas-config.json` and `settings-provenance.json` to be present within the
   checkout. Verify the config's `canvas.id` equals the directory's canvas ID
   and the provenance's `handoffId` and `requestId` match the frozen IDs.
   When the request exists, also require its exact `target` and
   `sourceFingerprint` to match the directory and provenance. If any check
   fails or the target is missing, report the exact error in chat; do not
   regenerate or select a different project extension.
3. Call `extensions_reload` **in this child session** before discovery, even
   when reopening after reset/clear. This terminates the Designer provider:
   do not reopen it or attempt an in-panel retry. If reload fails, report the
   error and target in chat without claiming the app opened.
4. Call `extensions_manage` with `operation: "list"`, then `operation:
   "inspect"` for the generated project extension. Run
   `.specify/extensions/extension-canvas-design/scripts/validate-generated-open.mjs`
   in `provider` mode with `<child-checkout> <canvas-id> <requestId>` and JSON
   stdin containing the **verbatim** management responses as
   `{"list":"<list output>","inspect":"<inspect output>"}`. On Windows a
   PowerShell here-string piped to `node <script> provider ...` avoids writing
   a result file. Stop on a nonzero exit: require exactly one running (or
   ready) project provider with its entry-point path at
   `<child-checkout>/.github/extensions/<canvas-id>/extension.mjs`, not a
   user-owned, stale, failed, or same-named provider from elsewhere.
5. Use the validated `extensionId` in `list_canvas_capabilities` for the
   frozen canvas ID. Run the validator in `canvas` mode with JSON stdin
   `{"capabilities":{"canvasId":"<ID explicitly returned by tool>",
   "extensionId":"<ID explicitly returned by tool>"}}`. Do not fill in a
   missing result ID from the request or infer it from an action list. Stop
   on a nonzero exit before opening. Call `open_canvas` for that exact
   extension ID and canvas ID, with instance ID `generated-<requestId>`.
   Run the validator in `open` mode with JSON stdin
   `{"opened":{"canvasId":"<returned ID>","extensionId":"<returned ID>",
   "instanceId":"<returned ID>"}}`. Copy only IDs explicitly returned by
   the open tool; a nonzero exit or missing field is a failed open.
6. Report the exact target and success only after the open result passes
   validation. Otherwise report the exact reload, registration, capability,
   or open error in the child chat. Do not claim success just because files
   exist, and do not call Generate or reopen Designer.

Generated canvases are not automatically updated when Canvas Design changes later.
