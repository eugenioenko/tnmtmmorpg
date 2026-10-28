# omens

World bosses. Every 25–35 minutes, while someone is out in the overworld, a great beast rises 30–45 tiles from a random player: *Old Hollowgut, Terror of the Eastern Wilds*. It is two levels above the strongest player online (at least level 4), with the bestiary's boss scaling. Everyone online gets a banner and a tracker in the right-hand column with its health, distance and a compass arrow.

**Spoils:** everyone who landed a blow and is within 40 tiles when it falls gets experience, gold, an **Omen Shard** (a trophy Odo buys for 60) and a 35% chance at the **Omen Charm** (+6 attack, +40 health). The player who dealt the most damage always gets a charm. The fall is announced with the names of the slayers.

**Timeout:** left alone for 15 minutes, it slinks back into the wilds.

**How it works:**
- The beast comes from the bestiary's `bestiary:spawn` with a boss name and title.
- Hits are counted from combat's spatial `entity:damage`, taking only the copy delivered to the boss itself.
- Rewards go out through `character:grant`.
- Each player's private `omens:alert` drives the client.
- Set `OMENS_FIRST_SECONDS` on the server to bring the first omen sooner (it is five minutes after boot otherwise).
