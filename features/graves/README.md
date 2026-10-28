# graves

Death has a price. When you fall outdoors, everything you had gathered (loot, materials, produce and trophies) stays behind in a grave 🪦 where you fell. Gear, tools, potions and food stay in your pack. A tracker in the right-hand column points the way back and counts down.

**Who can reclaim it:**
- For ten minutes, only you or your party can.
- After that, anyone who finds it can take what's inside.
- After thirty minutes, it crumbles and the items are lost.

**Where graves don't appear:** caves and interiors drop nothing, since those copies get torn down.

**How it works:**
- Graves are `graves:grave` entities keyed by character name and timed by the wall clock, so they survive logouts and restarts.
- The owner carries a private `graves:mine` for the tracker.
- Deaths arrive through combat's `combat:killed`.
- If your pack is too full to take everything, the rest stays in the grave.
