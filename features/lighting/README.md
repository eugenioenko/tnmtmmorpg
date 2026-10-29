# lighting

Light against the dark. The client draws night and caves dark; any entity with core's `light` component (`{ radius, color?, flicker?, intensity? }`) cuts a soft glowing hole through it.

- **Torches** (🔥): sold by the trader, or four from any log at the sawbench. Use one to carry it lit for eight minutes; use another while one burns to plant it at your feet for twenty, lighting the way for everyone.
- **Village lamps** (🏮) line the roads of the starting village, lit for good.
- **Campfires** burn here and there in the wilds. Stand beside one to mend.
- The forge, the bread oven and the portal pads glow on their own.

Day/night sets the outdoor darkness through `client.setDarkness('daynight', …)`; dungeons sets the cave darkness and lines about two caves in five with wall torches, while every cave has a few glowing crystals.
