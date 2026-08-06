# buildings

Scatters doors through the overworld — roughly one per chunk, on dry walkable
ground — and each opens onto its own interior world. Send `buildings:enter`
while standing on or beside a door to go in, and again at the exit to come
back out where you started.

An interior is not a hidden corner of the overworld: it is a separate world
whose id encodes the door's position (`interior:4821,5573`), carved by core's
room generator from a seed derived from that same position. So it costs
nothing until somebody opens the door, the same door always opens onto the
same room, and none of the layout has to be stored. Everything outside the
room is void — black and unwalkable — which is what makes a building read as
an interior rather than a walled field.
