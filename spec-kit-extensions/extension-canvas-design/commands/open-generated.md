---
description: Publish validated generated source, then register and open its exact project canvas.
---

## Context

$ARGUMENTS supplies the Designer handoff ID and frozen request ID. Run only in
that child session and checkout. Open never generates, installs packages, changes
provider enablement preferences, or runs workflow phases. Filesystem publication
and native activation are separate stages: publication success is not an opened
canvas.

## Steps

1. Obtain this session's absolute checkout and `session.workspacePath` from
   session metadata. Run
   `node .specify/extensions/extension-canvas-design/scripts/validate-generated-open.mjs
   target "<child-checkout>" "<session.workspacePath>" "<handoffId>" "<requestId>"`.
   Use only the returned `canvasId`, source `target`, and `publicationTarget`.
   The read-only validator checks the single supported request format, checkout,
   integrity, receipt, and exact emitted bytes. A present invalid request always
   fails. After reset/clear, only a unique already-published new-format app may
   reopen from its validated receipt; this does not permit first-time publication.
   Do not scan metadata yourself, migrate old apps, choose another app, or infer
   IDs from the registry.
2. Publish by running
   `node .specify/extensions/extension-canvas-design/scripts/publish-generated.mjs
   "<child-checkout>" "<session.workspacePath>" "<handoffId>" "<requestId>"`.
   Append `--replace-existing=<prior-request-id>` and
   `--expected-target-digest=<sha256>` only when the Open dispatch explicitly
   supplies both after a separate runtime-replacement confirmation. Generate
   consent and frozen requests never authorize publication replacement. The
   publisher copies validated bytes from `generated-canvases/<canvas-id>/` to
   `.github/extensions/<canvas-id>/`, with staging/backups outside discovery,
   guarded replacement, and rollback. Identical already-published bytes are
   reused without rewriting. On failure report **publication failed**, the exact
   error and any retained recovery path; stop before reload. Report returned
   cleanup warnings without hiding successful publication.
3. Call `extensions_reload` in this child session. Reload may disconnect
   Designer; do not reopen it or attempt an in-panel retry. On failure report
   **published, not opened — reload failed**, retaining the successful publication.
4. Call `extensions_manage` with `operation: "list"`, then `operation: "inspect"`
   for the exact generated project provider. Run the installed
   `validate-generated-open.mjs` in `provider` mode with
   `<child-checkout> <canvas-id> <requestId>` and JSON stdin containing the
   verbatim responses as `{"list":"<list output>","inspect":"<inspect output>"}`.
   Require exactly one running/ready `project:<canvas-id>` whose entry point is
   `<child-checkout>/.github/extensions/<canvas-id>/extension.mjs`. Reject
   disabled, failed, stale, duplicate, user-owned, and same-named foreign providers.
   On failure report **published, not opened — registration failed** and stop.
5. Call `list_canvas_capabilities` for the validated provider and frozen canvas
   ID. Run the validator in `canvas` mode with JSON stdin
   `{"capabilities":{"canvasId":"<explicit returned ID>",
   "extensionId":"<explicit returned ID>"}}`. Never infer missing result IDs.
   On failure report **published, not opened — capability validation failed**.
   Otherwise call `open_canvas` for those exact IDs with instance ID
   `generated-<requestId>`. Validate in `open` mode with JSON stdin
   `{"opened":{"canvasId":"<returned ID>","extensionId":"<returned ID>",
   "instanceId":"<returned ID>"}}`. Missing or mismatched IDs are failure.
6. Report opened success and the publication path only after native open
   validation succeeds. Otherwise report **published, not opened — open failed**
   and the exact error. Never delete a successful publication, regenerate,
   switch apps, toggle preferences, or claim success merely because files exist.

Generated canvases are not automatically updated when Canvas Design changes later.
