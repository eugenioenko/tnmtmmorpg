# Temporary Harvest Moon artwork

Extracted from the locally supplied **Harvest Moon (USA), SNES** ROM. The source
ROM stays in `assets/`; the browser uses only `atlas.png` and `atlas.json`.
The artwork retains its original ownership and is temporary project art.

- `atlas.png`: one 2048 × 8192 image, shared by terrain and all entity sprites.
- `atlas.json`: named frame rectangles, original drawing origins, frame durations,
  all 1,104 ROM animation sequences, 22 curated directional player sets, and 94
  background tile libraries from the 87 world/interior map presets.
- Animation groups organize farmer actions, villagers, animals, items/tools, and
  other objects/effects. These are browsing groups; some special scenes cross
  category boundaries. Title screens, text, and audio are outside this extraction.
- Background libraries retain all eight palette interpretations. The active game
  uses selected terrain tiles and object crops; water shifts the extracted pond
  pixels into a four-frame loop. All land, including marsh, stays still.
  Eight-neighbour textured fringes join biomes and a narrow sand rim follows
  water shores. These overlays also live in the single atlas. Side-facing
  characters mirror for west.

Rebuild from the repository root with Python 3 and Pillow installed:

```sh
python3 tools/extract-harvest-moon.py
# Or supply another path to the same US ROM (copier headers are supported):
python3 tools/extract-harvest-moon.py '/path/to/Harvest Moon (USA).sfc'
```

Open `/art.html` on the client dev server to browse animated assets by category
or inspect the player sets. The game assigns a stable scrambled character choice
from the entity ID so all clients see the same appearance. Both player movement
and animation render between server snapshots. The ROM's feet offsets keep
trimmed animation frames from jumping; depth follows the entity's ground position.

`packages/client/src/art.ts` is the skin adapter to replace with the artist's
atlas and mappings. Unsupported future entities retain their registered emoji.
Nearest-neighbor sampling and one pixel of padding protect the pixel edges.

Content features can supply an `appearance` component with `frame`, `scale`,
`originX`, `originY`, `tint`, and an optional colored `marker`. Building origins
line up the full exterior with its real door; portals have permanent bases and
destination labels rather than disappearing particle frames. The artwork
browser includes a buildings-and-props category.

Format research: [HM-Decomp](https://github.com/ElisaS-Codes/HM-Decomp), particularly
the graphics, animation, and palette table annotations. The extractor reads the
local ROM directly and needs no downloaded artwork or emulator.
