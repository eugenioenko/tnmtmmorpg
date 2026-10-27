# portals

Four portal pads at the exact centre of the overworld (5000, 5000), one per
themed world — the Cinder Waste, the Drowned Reach, the White Silence and the
Green Deep — plus a return pad at the centre of each of those, so no
destination is a one-way trip. Click a pad (or press Space beside one) to
send `portals:use` and travel — the client declares it as the pads'
interaction; the pads sit two tiles out from the centre so
the middle of the map stays crossable without being teleported. All this
feature owns is where the pads are and where they point: moving an entity
between worlds is `world.travel()`, which is core.
