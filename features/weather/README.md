# weather

Rain fronts, thunderstorms, fog, snow and blizzards, dust storms on the dunes and ash in the Cinder Waste.

- `sky.ts` computes the sky over any spot from the wall clock: two layers of value noise drift east, so fronts roll across the map and you can walk out from under a storm. Nothing is stored.
- Each player carries a private `weather:here` `{ sky, amount, wind, flash? }`. Other features may read it (the sound feature plays rain and thunder from it).
- Storms throw lightning. Now and then a bolt lands a few tiles away and leaves fused ground (`weather:scorch`) for a minute; dig it for Stormglass. Three Stormglass make a Storm Charm at the forge.
- The client draws everything on one canvas, darkens the day under heavy cloud through `setDarkness('weather', …)`, and shows a badge next to the clock.

Emits `weather:dug { entityId, count }`.
