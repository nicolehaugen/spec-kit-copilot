---
description: Generate a new source-owned workflow canvas from a frozen Canvas Designer request.
---

## Context

$ARGUMENTS must supply the Designer handoff ID and prepared request ID. Run in
the Designer child session and checkout only. This command does not install
packages or run workflow phases.

## Steps

1. Find this session's absolute checkout and `session.workspacePath` from session
   metadata; they are different paths. Read the frozen request at
   `<session.workspacePath>/speckit-canvas-designer/handoffs/<handoffId>/generations/<requestId>/request.json`.
   Use only these bounded IDs, never an arbitrary request path. Check the
   request's project binding, integrity, exact target, and installed runtime
   inventory. Do not substitute newer Designer edits or Designer-only package
   selections. Stop if `.github/extensions/<canvas-id>/` already exists.
2. Ensure that `.github/extensions/<canvas-id>/` does not already exist in
   the child checkout. Do not call `create-canvas` or scaffold a project extension.
3. Run `node .specify/extensions/extension-canvas-design/scripts/generate.mjs
   "<child-checkout>" "<session.workspacePath>" "<handoffId>" "<requestId>"`.
   This copies the maintained SDK entry point and workflow modules into a
   new `.github/extensions/<canvas-id>/`, writes the frozen configuration
   with runtime package IDs and the versions observed by Designer at Generate
   (or `unverified` when unavailable), plus observed priorities but no install-source
   paths or URLs, then validates the extension. The full install locators stay
   in the session-scoped handoff and request. It never overwrites an existing target.
   Source-fingerprint differences and installed-version drift are reported in
   the command's `warnings` output; report them to the user, but proceed with the intact frozen request
   when checkout, target, workflow, and installed inventory checks pass.
   On failure, report the error unchanged and leave any partial target for
   inspection; do not create an alternative implementation or retry.
4. After successful validation, call `extensions_reload` in this child session
   to register the generated project extension. Reloading stops the Designer
   provider; the Designer panel is intentionally not reopened automatically.
   The panel's settings were saved and editing locked when Generate was clicked.
   If reload fails, report the error and the generated target without claiming
   the app opened.
5. Call `extensions_manage` with `operation: "list"`, then `operation:
   "inspect"` for the generated extension. Verify its entry-point path is
   `<child-checkout>/.github/extensions/<canvas-id>/extension.mjs`. Require its
   source to be this child project and its status to be ready; do not substitute
   an extension from another session or provider with the same canvas ID.
   Use its registered extension ID in `list_canvas_capabilities` for the frozen
   canvas ID; reject a missing or mismatched canvas. Then call `open_canvas`
   for that exact provider and canvas ID with a new instance ID
   `generated-<requestId>`. Check the open result's canvas ID, extension ID,
   and instance ID. Report an unavailable, incompatible, or failed open as a
   failure; do not claim the app opened merely because files were generated.
6. Report the generated target and any warnings, whether the app opened, and
   that the user can close this Designer panel and reopen Designer manually
   for another app. Do not reopen Designer or run a workflow phase.

Generated canvases are not automatically updated when this extension changes later.
