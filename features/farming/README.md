# farming

Grow your own food. Buy a **Hoe** and a **Watering Can** from Odo, and wheat, carrot or pumpkin **seeds** from Morwen. They all sit in your quick slots.

- **Till:** use the hoe on the grass or bare earth you stand on to make a plot. Not on the village roads, and up to 24 plots each.
- **Plant:** use seeds while on or beside one of your empty plots.
- **Grow:** crops grow from seedling to ripe in about 3, 4½ and 7½ minutes of real time. They keep growing while you're away, slow down at night (with the `daynight` feature), and a splash from the can (every crop around you, once per stage) hurries them along.
- **Tend:** click a plot (or press Space beside it) to see how long is left, plant seeds in it if it's empty, or harvest it once ripe. A harvest gives produce, seeds to replant and some experience.
- **Bake:** the **Bread Oven** by the farmhouse turns wheat into Farmhouse Loaves, carrots and wheat into Carrot Stew, and a pumpkin and wheat into Pumpkin Pie. All three heal, up to 200 health for a pie. Odo and Morwen buy surplus produce.

**Rules:**
- Only the owner, or their party, may harvest a plot, until a ripe crop has been left standing for twenty minutes.
- Empty plots go fallow and vanish after twenty minutes.

**How it works:**
- Plots are `farming:plot` entities drawn through `appearance.emoji`, so each one shows its stage.
- Growth is measured in wall-clock time, so it carries across restarts.
- The original `farming:seed` (tagged `herb`) is still here for the cross-feature interop test, along with the `+4 seeds` developer button.
