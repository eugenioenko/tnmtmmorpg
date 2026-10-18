# buildings

Builds a starting village around the portal square: four complete building
exteriors with colliding walls, connected paths, a well, storage props, trees,
and fenced crops. A nearby lake, woodland, marsh, and northern highlands show
the terrain types. Generation runs a few rows per tick and persists. Outside
the village, chunk decoration places homesteads on suitable ground. All props
use the shared atlas through their `appearance` component. Send `buildings:enter`
while standing on or beside a door to go in, and again at the exit to come
back out where you started.

Each building opens onto a furnished interior. An interior is a separate world
whose id encodes the door's position (`interior:4821,5573`), carved by core's
room generator from a seed derived from that same position. So it costs
nothing until somebody opens the door, the same door always opens onto the
same room, and none of the layout has to be stored. Everything outside the
room is void — black and unwalkable — which is what makes a building read as
an interior rather than a walled field.
