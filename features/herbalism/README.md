# herbalism

Wild herbs grow in every biome: Meadowsweet in the meadows, Mossroot in the forests, Sunpetal on the beaches, Bog Myrtle in the swamps, and Frostbloom on the snow. Glowcap grows only in the deep forest far from the village, and Moonpetal opens only at night. Frostbloom, Glowcap and Moonpetal glow softly in the dark. Click a herb to gather it; no tool is needed. Herbalism levels from 1 to 30, and the rarer herbs need a higher level. A picked herb leaves a sprout 🌱 that grows back in four minutes.

The **Cauldron** 🫕 beside the Alchemist's house brews herbs into potions: the character feature's three healing draughts, the **Night Eye Draught** (four minutes of seeing in the dark, through core's `light`), and the **Mana Tonic** (60 mana, through the classes feature's `classes:restore` event). Press `N` for the field guide.

Herbs are scattered in newly generated chunks. On first run, the ground the village had already explored is sown once.

Emits `herbalism:gathered { entityId, herb, count }`.
