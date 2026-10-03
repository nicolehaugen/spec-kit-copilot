# Risk-matrix Canvas Design test preset

This repository-local fixture is intentionally absent from `catalog.json`.
Its appended `load-page` command registers four distinct, replace-only
Specify named templates: `control.definition`, `designer.field`,
`designer.adapter`, and `generated.adapter`. Only the command is appended;
the JSON files and complete `.mjs` modules are never appended, merged, or
registered as Specify scripts. Resolve all four names before opening
Designer. There is no separate Designer tab: the field is placed in
`essentials.options`, and its explicit `generatedBinding` places the
generated control in `details.content`. A missing or invalid adapter must
not fall back to stock text.

The `risk-matrix` control defines the frozen `risk.rating` value:
`{impact, likelihood}`, where both properties are required, no others are
allowed, and each is exactly `low`, `medium`, or `high`. Designer initially
receives `null` as an unselected draft. The host must reject an incomplete or
invalid value on Save and Generate. The Designer adapter permits `null` until
the user selects a cell; the generated adapter requires a complete value.

Both complete, self-contained host modules export `mount`. Designer calls
`mount({root, field, value, onChange})`; generated calls
`mount({root, field, value})`. `root` is an exclusively owned DOM element,
`field` is the resolved field definition with `id`, and `onChange(nextValue)`
requests a draft update for host-side validation and persistence. The host
supplies values by field ID and re-mounts when the value changes; the adapter
replaces only its owned root's contents. Generate packages the winning
generated `.mjs` locally with the source-owned app. There are no imports,
external calls, runtime edits, or stock scalar adapter files.

Impact runs across columns and likelihood down rows. Tab enters the selected
cell (or the first cell when unselected); arrows move and select, Home/End
move to the first/last cell, and Space/Enter select. Visible focus, labeled
axes and cells, and a read-only generated table with one marked selected
cell make the rating understandable without relying on color.
