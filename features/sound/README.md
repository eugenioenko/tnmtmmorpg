# sound

Music and ambience for every zone, synthesised live in the browser with WebAudio. There are no audio files.

- **Music** is improvised in each zone's own mode, tempo and instruments: a lute in pentatonic major in the village; a lydian flute over the meadows; a dorian flute and low drone in the woods; phrygian bells in the fens; a phrygian-dominant pluck and hand drum on the dunes; sparse bells on the snowfields; a drone and distant bells underground; a cosy lute indoors; and a distinct score for each portal world. At night the music slows and thins. Moving between zones crossfades over about four seconds, after you've been in the new zone for a couple of seconds, so a border doesn't flicker.
- **Ambience**: wind that drifts in level and colour, surf that swells near water, and creature calls by zone and time of day (birds, crickets, owls, woodpeckers, frogs, gulls, cave drips, distant rumbles). Fires crackle as you approach them: any `light` with flicker ≥ 0.5, so campfires, torches, the forge and cave sconces.
- **Mixer** window (`M`) with master, music, ambience and effects sliders and a mute toggle. It is saved per browser in `localStorage`.

Audio starts on the first click or key press, as browsers require. `engine.ts` works on any `BaseAudioContext`, so an `OfflineAudioContext` can render a zone for testing.
