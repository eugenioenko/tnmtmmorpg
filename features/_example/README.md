# _example

The tutorial feature, kept working as the reference every contributor copies. To create a new feature, copy this folder: register items, recipes, entity kinds, systems, commands and event handlers in `index.ts`, add optional UI panels and sprite glyphs in `client.tsx`, and describe what the feature does in your own README. Nothing outside the folder ever needs to change — the server scans `features/*/index.ts` at boot and the client discovers `client.tsx` via `import.meta.glob`, so a dropped-in folder is a live feature. `FEATURES=_example` boots with only this feature loaded.
