# fishing

Cast a line, watch the bobber, and reel in when it bites.

- **Rod**: `fishing:rod`. Odo sells it, or the sawbench cuts one from 2 wood. Use it near open water (within 4 tiles) to cast. When the bobber jerks and a `!` appears, use it again within 2 s to reel in. Stepping away reels in.
- **What bites** depends on the shore around the bobber (meadow, forest, fens, dunes, snowfields, highlands), your level, the hour (eels, squid and moonfish come out at night), the sky (stormfin only in a thunderstorm, read from `weather:here`), and the world (Drowned Reach has lanternfish and pearl oysters). There is junk too: boots, driftwood (burns as wood), bottled notes you can read, and the rare sunken chest of coins.
- **Skill** 1–30 (`fishing:skill`) and a **journal** of every catch (`fishing:journal`, window on Y). Both are private and persist.
- **Cooking** at the farm's oven: Grilled Fish (any fish, heals 45) and Fisher's Stew (2 fish and a herb, heals 120).
- `fishing:line` is public, so other players see your line and bobber. `fishing:caught { icon, at, x, y }` drives the catch animation.

Emits `fishing:caught { entityId, item, fish }`. The titles feature counts the fish toward *the Angler*.
