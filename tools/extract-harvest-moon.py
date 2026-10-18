#!/usr/bin/env python3
"""Extract the supplied US SNES ROM into one atlas. Requires Pillow.

Format reference: https://github.com/ElisaS-Codes/HM-Decomp
No emulator, downloaded art, or ROM contents are needed at runtime.
"""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageChops
from functools import lru_cache
from collections import deque
ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("rom", nargs="?", type=Path, default=ROOT / "assets/Harvest Moon/Harvest Moon (USA).sfc")
args = parser.parse_args()
R = args.rom.read_bytes()
if len(R) % 32768 == 512:
    R = R[512:]  # Optional copier header.
if len(R) != 2097152 or R[0x7FC0:0x7FD5].rstrip() != b"HARVEST MOON":
    raise SystemExit("Expected the 2 MiB Harvest Moon (USA) SNES ROM")
def pc(a): return ((a>>16)&127)*32768+(a&32767)
def word(a): return int.from_bytes(R[pc(a):pc(a)+2],'little')
def ptr(a): return int.from_bytes(R[pc(a):pc(a)+3],'little')
def pal(a):
 return [tuple(((word(a+i*2)>>s)&31)*255//31 for s in (0,5,10))+(255,) for i in range(256)]
SP=pal(ptr(0x80B9FD+0x6B*3))
BG=pal(0xA89400)
def decomp(a):
 p=pc(a); size=int.from_bytes(R[p:p+2],'little'); p+=4
 out=bytearray(); ring=bytearray(2048); w=2014
 while len(out)<size:
  flags=R[p]; p+=1
  for bit in range(8):
   if flags&(1<<bit): vals=[R[p]]; p+=1; offset=None
   else:
    offset=R[p]|((R[p+1]&224)<<3); n=(R[p+1]&31)+3; p+=2; vals=range(n)
   for v in vals:
    if offset is not None: v=ring[offset]; offset=(offset+1)&2047
    out.append(v); ring[w]=v; w=(w+1)&2047
    if len(out)==size: break
   if len(out)==size: break
 return bytes(out)
@lru_cache(None)
def tile_indices(d):
 if len(d)<32:return bytes(64)
 return bytes(sum(((d[y*2+(b%2)+(16 if b>=2 else 0)]>>(7-x))&1)<<b
                  for b in range(4)) for y in range(8) for x in range(8))

def tile(data,idx,palette,transparent=True):
 indices=tile_indices(data[idx*32:idx*32+32])
 return Image.frombytes('RGBA',(8,8),bytes(channel for v in indices
     for channel in (palette[v] if v or not transparent else (0,0,0,0))))
@lru_cache(None)
def obj(idx,attr):
 a=0x888000+(idx//256)*0x10000+((idx%256)//64)*0x2000
 n=idx%64; t=(n//8)*32+(n%8)*2
 data=R[pc(a):pc(a)+0x2000]; im=Image.new('RGBA',(16,16))
 for j,k in enumerate((t,t+1,t+16,t+17)):im.paste(tile(data,k,SP[(attr&7)*16:]),((j%2)*8,(j//2)*8))
 if attr&0x20: im=im.transpose(Image.FLIP_LEFT_RIGHT)
 if attr&0x10: im=im.transpose(Image.FLIP_TOP_BOTTOM)
 return im
@lru_cache(None)
def frame(a):
 p=pc(a); count=R[p]; comps=[]
 for i in range(count):
  q=p+1+5*i; idx=int.from_bytes(R[q:q+2],'little'); x=int.from_bytes(R[q+2:q+3],'little',signed=True);y=int.from_bytes(R[q+3:q+4],'little',signed=True);attr=R[q+4]
  comps.append((idx,x,y,attr))
 if not comps:return Image.new('RGBA',(1,1)),(0,0)
 x0=min(c[1] for c in comps);y0=min(c[2] for c in comps);x1=max(c[1]+16 for c in comps);y1=max(c[2]+16 for c in comps)
 im=Image.new('RGBA',(x1-x0,y1-y0))
 for idx,x,y,attr in reversed(comps):im.alpha_composite(obj(idx,attr),(x-x0,y-y0))
 return im,(x0,y0)
def animation(i):
 bank=0x86 if i<610 else 0x87; n=i if i<610 else i-610
 a=(bank<<16)|word((bank<<16)+0x8080+n*2); seq=[]
 for j in range(128):
  f=word(a);ticks=R[pc(a)+2]
  if f==0:break
  seq.append(((bank<<16)|f,ticks));a+=3
  if ticks==255:break
 return seq


class Atlas:
    """Deterministic rectangle packing, with extruded pixels around each frame."""
    def __init__(self):
        self.image = Image.new('RGBA', (2048, 8192))
        self.x = self.y = self.row = 0
        self.frames = {}
        self.pixels = {}
        self.entries = {}
        self.free = [(0, 0, 2048, 8192)]

    def add(self, name, image, origin=(0, 0)):
        self.entries[name] = (image, origin)
        return name

    def pack(self):
        for name, (image, origin) in sorted(self.entries.items(),
                key=lambda entry: (-entry[1][0].height, -entry[1][0].width, entry[0])):
            self._pack(name, image, origin)

    def _pack(self, name, image, origin):
        # Deduplicate pixels while retaining each logical asset name and origin.
        key = (image.size, image.tobytes())
        if key in self.pixels:
            rect = self.pixels[key]
        else:
            w, h = image.size
            fits = [(fw * fh, i) for i, (_, _, fw, fh) in enumerate(self.free)
                    if w + 2 <= fw and h + 2 <= fh]
            if not fits:
                raise ValueError('Atlas overflow')
            _, i = min(fits)
            fx, fy, fw, fh = self.free.pop(i)
            x, y = fx + 1, fy + 1
            if fw > w + 2:
                self.free.append((fx + w + 2, fy, fw - w - 2, h + 2))
            if fh > h + 2:
                self.free.append((fx, fy + h + 2, fw, fh - h - 2))
            self.image.paste(image, (x, y))
            self.image.paste(image.crop((0, 0, w, 1)), (x, y - 1))
            self.image.paste(image.crop((0, h - 1, w, h)), (x, y + h))
            self.image.paste(image.crop((0, 0, 1, h)), (x - 1, y))
            self.image.paste(image.crop((w - 1, 0, w, h)), (x + w, y))
            rect = [x, y, w, h]
            self.pixels[key] = rect
            self.y = max(self.y, y + h + 1)
        self.frames[name] = rect + list(origin)
        return name


def map_data(map_id):
    a = 0x800000 | word(0x80AA7C + map_id * 2)
    p = pc(a)
    graphics = bytearray(32768)
    blocks = []
    for j in range(R[p + 5]):
        address = ptr(a + 17 + j * 5)
        data = decomp(address)
        dest = word(a + 15 + j * 5) * 2 - 0x4000
        graphics[dest:dest + len(data)] = data
        blocks.append(address)
    c = a + 15 + R[p + 5] * 5
    address = ptr(c + 2)
    data = R[pc(address):pc(address) + 32768] if word(a + 1) & 0x8000 else decomp(address)
    # Each map has six time-of-day palette slots; use the first daylight one.
    palette_ids = R[pc(0x80BB5C) + map_id * 6:pc(0x80BB5C) + map_id * 6 + 6]
    palette_id = next((n for n in palette_ids if n != 255), 0)
    colors = pal(ptr(0x80B9FD + palette_id * 3))
    return bytes(graphics), data, colors, blocks


def map_tile(graphics, data, colors, x, y, stride):
    im = Image.new('RGBA', (16, 16), colors[0])
    for dy in range(2):
        for dx in range(2):
            i = ((y * 2 + dy) * stride + x * 2 + dx) * 2
            v = int.from_bytes(data[i:i + 2], 'little')
            t = tile(graphics, v & 1023, colors[((v >> 10) & 7) * 16:])
            if v & 0x4000:
                t = t.transpose(Image.FLIP_LEFT_RIGHT)
            if v & 0x8000:
                t = t.transpose(Image.FLIP_TOP_BOTTOM)
            im.alpha_composite(t, (dx * 8, dy * 8))
    return im


def main():
    atlas = Atlas()
    animations = {}
    # Both complete animation tables: farmer, tools, items, animals, villagers,
    # effects, and special scenes. Preserve original frame durations (60 Hz).
    for i in range(1104):
        seq = []
        for address, ticks in animation(i):
            im, origin = frame(address)
            name = f'objects/frames/{address:06x}'
            atlas.add(name, im, origin)
            seq.append({'frame': name, 'ticks': ticks})
        animations[str(i)] = seq

    # Complete background tile libraries referenced by all 87 world/interior
    # map presets, deduplicated by graphics address and daylight palette.
    tilesets = {}
    seen = set()
    for map_id in range(0x57):
        graphics, _, colors, blocks = map_data(map_id)
        for j, address in enumerate(blocks):
            key = (address, tuple(colors[:128]))
            if key in seen:
                continue
            seen.add(key)
            data = decomp(address)
            # Preserve all 8 palette interpretations; tilemaps choose among them.
            sheet = Image.new('RGBA', (128, 128 * 8))
            for palette in range(8):
                for n in range(len(data) // 32):
                    sheet.paste(tile(data, n, colors[palette * 16:], False),
                                ((n % 16) * 8, palette * 128 + (n // 16) * 8))
            name = f'terrain/tilesets/map-{map_id:02x}-{address:06x}'
            atlas.add(name, sheet)
            tilesets[name] = {'map': map_id, 'address': f'{address:06x}', 'tileSize': 8,
                             'columns': 16, 'paletteRows': 128}

    graphics, data, colors, _ = map_data(0)
    farm = Image.new('RGBA', (1024, 1024))
    for y in range(64):
        for x in range(64):
            farm.paste(map_tile(graphics, data, colors, x, y, 128), (x * 16, y * 16))

    def crop(name, box, transparent=False):
        im = farm.crop(box)
        if transparent:
            # Remove connected ground around the silhouette; preserve similarly
            # colored wood enclosed by the building's dark outline.
            soil = set(farm.crop((400, 48, 416, 64)).getdata()) | {colors[0]}
            queue = deque([(x, y) for y in range(im.height) for x in range(im.width)
                           if x in (0, im.width - 1) or y in (0, im.height - 1)])
            visited = set()
            while queue:
                x, y = queue.popleft()
                if (x, y) in visited or not (0 <= x < im.width and 0 <= y < im.height):
                    continue
                visited.add((x, y))
                if im.getpixel((x, y)) not in soil:
                    continue
                im.putpixel((x, y), (0, 0, 0, 0))
                queue.extend([(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)])
        return atlas.add(name, im)

    terrain = {
        'grass': [crop('terrain/grass', (32, 992, 48, 1008))],
        'dirt': [crop('terrain/dirt', (400, 48, 416, 64))],
        'water': [crop('terrain/water', (520, 520, 536, 536))],
        'sand': [crop('terrain/sand', (400, 48, 416, 64))],
        'forest': [crop('terrain/forest', (48, 992, 64, 1008))],
        'snow': [crop('terrain/snow', (32, 992, 48, 1008))],
        'swamp': [crop('terrain/swamp', (520, 520, 536, 536))],
        'mountain': [crop('terrain/mountain', (48, 16, 64, 32))],
    }
    for map_id, kind, xy in [(0x0C, 'grass', (0, 2)), (0x0C, 'forest', (0, 2)),
                             (3, 'snow', (2, 62)), (0x15, 'floor', (7, 12)),
                             (0x29, 'wall', (1, 2))]:
        gfx, m, colors2, _ = map_data(map_id)
        stride = int((len(m) // 2) ** 0.5)
        im = map_tile(gfx, m, colors2, *xy, stride)
        terrain[kind] = [atlas.add(f'terrain/{kind}', im)]
    # Seamless water loop derived from the extracted pond, shifting the source
    # pixels rather than introducing art from another source.
    water = farm.crop((520, 520, 536, 536))
    terrain['water'] = [atlas.add(f'terrain/water-{i}', ImageChops.offset(water, i * 2, i * 2))
                        for i in range(4)]
    # Marsh is solid walkable ground, so it must never animate like open water.
    terrain['swamp'] = [atlas.add('terrain/marsh-ground', farm.crop((400, 48, 416, 64)))]
    terrain['void'] = [atlas.add('terrain/void', Image.new('RGBA', (16, 16), (0, 0, 0, 255)))]
    crop('objects/tree', (768, 192, 816, 256), True)
    crop('objects/boulder', (480, 64, 512, 96), True)
    crop('objects/well', (240, 400, 288, 448), True)
    crop('objects/door', (416, 448, 432, 480), True)
    crop('buildings/cottage', (96, 240, 160, 336), True)
    crop('buildings/barn', (256, 272, 368, 352), True)
    crop('buildings/storehouse', (384, 400, 464, 480), True)
    crop('objects/stump', (288, 64, 320, 96), True)
    crop('objects/small-rock', (128, 48, 144, 64), True)
    crop('objects/fence', (48, 208, 64, 224), True)
    crop('objects/portal-base', (128, 352, 144, 368), True)
    crop('objects/barrel', (800, 864, 832, 896), True)
    plant, _ = frame(animation(300)[0][0])
    atlas.add('objects/crop', plant)

    # Directional sets are curated to avoid assigning tool effects or half of
    # an unrelated character to players. Side views are mirrored for west.
    characters = [{'id': 'farmer', 'idle': [5, 6, 7], 'walk': [0, 1, 2]}]
    for i, base in enumerate([543, 551, 573, 581, 588, 603, 618, 625, 631,
                              637, 649, 656, 663, 670, 676, 684, 690, 703,
                              709, 717, 723]):
        characters.append({'id': f'villager-{i + 1:02}',
                           'idle': [base - 1, base + 1, base + 3],
                           'walk': [base, base + 2, base + 4]})
    # Eight-neighbour edge masks. Existing terrain pixels provide the color;
    # masks add a small irregular fringe and rounded diagonal joins. All of
    # these overlays remain in the same shared image as the original art.
    for mask in range(1, 256):
        solid = set()
        for y in range(16):
            for x in range(16):
                fringe_x = 2 + (1 if x % 7 in (2, 3, 4) else 0)
                fringe_y = 2 + (1 if y % 7 in (2, 3, 4) else 0)
                edge = ((mask & 1 and y < fringe_x) or
                        (mask & 2 and 15 - x < fringe_y) or
                        (mask & 4 and 15 - y < fringe_x) or
                        (mask & 8 and x < fringe_y))
                for bit, cx, cy in [(16, 0, 0), (32, 15, 0), (64, 15, 15), (128, 0, 15)]:
                    if mask & bit and (x - cx) ** 2 + (y - cy) ** 2 < 20:
                        edge = True
                if edge:
                    solid.add((x, y))
        for kind in ['grass', 'forest', 'sand', 'dirt', 'swamp', 'mountain', 'snow']:
            original = atlas.entries[terrain[kind][0]][0]
            overlay = Image.new('RGBA', (16, 16))
            for x, y in solid:
                overlay.putpixel((x, y), original.getpixel((x, y)))
            atlas.add(f'transitions/{kind}/{mask}', overlay)
        # A narrow sand rim follows the same mask, including diagonal neighbours.
        rim = Image.new('RGBA', (16, 16))
        sand = atlas.entries[terrain['sand'][0]][0]
        for y in range(16):
            for x in range(16):
                if (x, y) in solid:
                    continue
                if any((x + dx, y + dy) in solid for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]):
                    r, g, b, a = sand.getpixel((x, y))
                    rim.putpixel((x, y), (min(255, r + 35), min(255, g + 35), min(255, b + 20), a))
        atlas.add(f'transitions/shore/{mask}', rim)
    atlas.pack()
    height = 1
    while height < atlas.y + atlas.row:
        height *= 2
    out = ROOT / 'packages/client/src/art/harvest-moon'
    out.mkdir(parents=True, exist_ok=True)
    atlas.image.crop((0, 0, 2048, height)).save(out / 'atlas.tmp.png', optimize=True)
    (out / 'atlas.tmp.png').replace(out / 'atlas.png')
    groups = {
        'characters/farmer': list(range(183)),
        'items-and-tools': list(range(183, 394)),
        'animals': list(range(394, 542)),
        'characters/villagers': list(range(542, 738)),
        'objects-and-effects': list(range(738, 1104)),
    }
    manifest = {'source': 'Harvest Moon (USA), SNES', 'sha256': hashlib.sha256(R).hexdigest(),
                'size': [2048, height], 'frames': atlas.frames, 'animations': animations,
                'characters': characters, 'terrain': terrain, 'tilesets': tilesets,
                'groups': groups}
    (out / 'atlas.tmp.json').write_text(json.dumps(manifest, separators=(',', ':')) + '\n')
    (out / 'atlas.tmp.json').replace(out / 'atlas.json')
    print(f'{len(atlas.frames)} frames, {len(animations)} animations, {len(tilesets)} tilesets; '
          f'one 2048x{height} atlas ({(out / "atlas.png").stat().st_size:,} bytes)')


if __name__ == '__main__':
    main()
