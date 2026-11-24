# Bug Fix - Autopilot

A generated Copilot App canvas for the Spec Kit `bug` extension. It guides a bug
through the assess, fix, and test phases and tracks the resulting artifacts in
`.specify/bugs/<slug>/`.

The canvas is registered by the `spec-kit-copilot-bugfix` plugin. Install the
plugin from the Spec Kit Copilot marketplace, then ask Copilot to open **Bug
Fix - Autopilot**. The Setup action can install the `bug` extension when it is
missing.

The workflow uses the installed `speckit.bug.assess`,
`speckit.bug.fix`, and `speckit.bug.test` skills. Assessment, fix, and
verification reports are produced by those skills; the canvas displays their
status and artifacts.
