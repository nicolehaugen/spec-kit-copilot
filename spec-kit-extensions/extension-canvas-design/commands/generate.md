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
4. After successful validation, call `extensions_reload`, inspect the project
   provider and open its canvas with a new instance ID. Only call generation
   successful if the provider registers and opens. Do not run a workflow phase.

Generated canvases are not automatically updated when this extension changes later.
