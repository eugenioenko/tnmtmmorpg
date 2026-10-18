# nature

Decorates newly explored chunks with trees, bushes, boulders, and stumps. Forests
have denser trees than grassland; roads, buildings, water, and the starting square
remain clear. Decoration uses the chunk's seeded random stream and persists,
so restarting does not grow another population. When the buildings feature
finishes its village, a `buildings:village-ready` listener removes this feature's
scenery from newly laid roads, walls, and water. Props are stationary and share
the terrain/character atlas.
