# farming

A minimal feature whose entire purpose is the interop test: it registers one
item (`farming:seed`, tagged `herb`) that other features can consume by tag.
Stand next to a workbench, `+4 seeds` from the Farming panel, and craft
`_example:glowing_essence` — the `_example` recipe requires `{ tag: 'herb',
count: 2 }` and consumes the seeds without the two features ever importing
each other.
