#!/usr/bin/env python3
"""
The badge art (client/assets/badges/<id>.svg), one small hand-written SVG per
badge on a shared gold medallion (96 x 96). The file name is the badge id of
server/game/badges.js (server/game/__tests__/badges.test.js holds the two
lists to each other). Colours follow client/tokens/tokens.json (gold, card
red, green, card paper).

  python3 scripts/build-badges.py        # rewrites every file (and the iOS app's copies)

To add a badge: add its emblem to EMBLEMS here, its entry to BADGES in
server/game/badges.js, and run this script.
"""
import math, os
OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'client', 'assets', 'badges'))
GOLD, RIM, RING, INK = '#f2c14e', '#a9761b', '#d9a336', '#4a3208'
RED, RED_D, GREEN, PAPER = '#d91a1a', '#8a0f0f', '#0f7a33', '#fffdf8'

def arrow(a, b, w, hl, hw, fill):
    (ax, ay), (bx, by) = a, b
    L = math.hypot(bx-ax, by-ay); ux, uy = (bx-ax)/L, (by-ay)/L; px, py = -uy, ux
    mx, my = bx-ux*hl, by-uy*hl
    pts = [(ax+px*w/2, ay+py*w/2), (mx+px*w/2, my+py*w/2), (mx+px*hw/2, my+py*hw/2), (bx, by),
           (mx-px*hw/2, my-py*hw/2), (mx-px*w/2, my-py*w/2), (ax-px*w/2, ay-py*w/2)]
    d = ' '.join(f'{x:.1f},{y:.1f}' for x, y in pts)
    return f'<polygon points="{d}" fill="{fill}" stroke="{fill}" stroke-width="2" stroke-linejoin="round"/>'

def five(x): return f'<path d="M{x+16},33 H{x+1} V46 H{x+9} a8.5,8.5 0 0 1 0,17 H{x}"/>'
def zero(x): return f'<rect x="{x}" y="33" width="16" height="30" rx="8"/>'

EMBLEMS = {
 'five-hundred': f'<g transform="translate(48 48) scale(0.88) translate(-48.5 -48)" fill="none" stroke="{INK}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">{five(15)}{zero(41)}{zero(65)}</g>',
 'comeback-kid': arrow((22,40),(37,55),6,10,15,RED) + arrow((45,65),(73,29),9,16,23,GREEN),
 'choke-artist': arrow((22,56),(37,41),6,10,15,GREEN) + arrow((45,31),(73,67),9,16,23,RED),
 'heavy-hitter': f'''<g transform="rotate(14 48 48)" stroke="{RED_D}" stroke-width="2" stroke-linejoin="round">
  <path d="M37,59 V40 C37,27 45,20 54,20 C64,20 71,28 71,39 C71,48 67,54 63,59 Z" fill="{RED}"/>
  <path d="M38,41 C31,37 24,41 25,49 C26,56 33,59 39,56 Z" fill="{RED}"/>
  <rect x="35" y="59" width="30" height="14" rx="3" fill="{PAPER}"/>
  <path d="M35,66 H65" fill="none"/></g>''',
 'bet-big-win-big': f'''<circle cx="48" cy="48" r="27" fill="{RED}" stroke="{RED_D}" stroke-width="2"/>
  <circle cx="48" cy="48" r="22.5" fill="none" stroke="{PAPER}" stroke-width="7" stroke-dasharray="8.84 8.83" transform="rotate(-12.5 48 48)"/>
  <circle cx="48" cy="48" r="14" fill="{RED}" stroke="{PAPER}" stroke-width="2.5"/>''',
 'lost-the-farm': f'''<path d="M27,71 V47 L33,35 L48,25 L63,35 L69,47 V71 Z" fill="{RED}" stroke="{RED_D}" stroke-width="2" stroke-linejoin="round"/>
  <path d="M23,48 L31,33 L48,21.500 L65,33 L73,48" fill="none" stroke="{RED_D}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="44" y="34" width="8" height="8" fill="{PAPER}"/>
  <g fill="none" stroke="{PAPER}" stroke-width="2.2" stroke-linejoin="round"><rect x="39" y="51" width="18" height="20"/><path d="M39,51 L57,71 M57,51 L39,71"/></g>''',
}
GREY, GREY_D, BLUE, BLUE_D, BLUE_L, ORANGE, WIRE = '#a3aaae', '#4e555a', '#2b5fa8', '#173a6b', '#4a82cf', '#ef7d1a', '#33383d'
def wire(a, b, n):
    (ax, ay), (bx, by) = a, b
    ang = math.atan2(by-ay, bx-ax)
    out = f'<path d="M{ax},{ay} L{bx},{by}"/>'
    for i in range(n):
        t = (i + 0.5) / n; x, y = ax+(bx-ax)*t, ay+(by-ay)*t
        for s in (1, -1):
            c, d = math.cos(ang + s*1.13)*4.5, math.sin(ang + s*1.13)*4.5
            out += f'<path d="M{x-c:.1f},{y-d:.1f} L{x+c:.1f},{y+d:.1f}"/>'
    return out
def bow(cx, cy, radii):
    return ''.join(f'<path d="M{cx-r},{cy} A{r},{r} 0 0 1 {cx+r},{cy}" stroke="{c}"/>' for r, c in zip(radii, (RED, ORANGE, GREEN, BLUE)))
EMBLEMS.update({
 'in-the-red': f'<path d="M21,31 L33,43 L41,36 L53,54 L60,47 L68,59" fill="none" stroke="{RED}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>' + arrow((66,56),(74,68),5.5,11,16,RED),
 'felted': f'''<path d="M32,71 V42 a16,16 0 0 1 32,0 V71 Z" fill="{GREY}" stroke="{GREY_D}" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M48,37 V57 M41,44 H55" fill="none" stroke="{GREY_D}" stroke-width="3.5" stroke-linecap="round"/>
  <path d="M25,72 H71" fill="none" stroke="{GREEN}" stroke-width="5" stroke-linecap="round"/>''',
 'hurt-people-mode': f'''<g transform="rotate(-40 48 48)"><g fill="#a8622a" stroke="#5a3413" stroke-width="2" stroke-linejoin="round">
  <path d="M20,45.5 L40,45.5 C50,45 56,41 64,41 L73,41 a7,7 0 0 1 0,14 L64,55 C56,55 50,51 40,50.5 L20,50.5 Z"/>
  <rect x="15.500" y="43" width="5" height="10" rx="2"/></g>
  <g fill="none" stroke="{WIRE}" stroke-width="2.2" stroke-linecap="round">{wire((54,39),(59,57),2)}{wire((62,38),(67,58),2)}{wire((70,38),(75,58),2)}</g></g>''',
 'double-rainbow': f'<g fill="none" stroke-width="3">{bow(48,61,(30.5,27.5,24.5,21.5))}{bow(48,61,(14.5,11.5,8.5,5.5))}</g>',
 'backpack': f'''<path d="M42,29 a6,6 0 0 1 12,0" fill="none" stroke="{BLUE_D}" stroke-width="3.5" stroke-linecap="round"/>
  <path d="M30,41 C23,45 23,61 29,66 M66,41 C73,45 73,61 67,66" fill="none" stroke="{BLUE_D}" stroke-width="4" stroke-linecap="round"/>
  <rect x="30" y="29" width="36" height="43" rx="11" fill="{BLUE}" stroke="{BLUE_D}" stroke-width="2.5"/>
  <path d="M31,44 H65" fill="none" stroke="{BLUE_D}" stroke-width="2.5"/>
  <rect x="36" y="50" width="24" height="16" rx="4" fill="{BLUE_L}" stroke="{BLUE_D}" stroke-width="2"/>
  <rect x="45.500" y="41" width="5" height="7" rx="1" fill="{PAPER}" stroke="{BLUE_D}" stroke-width="1.5"/>''',
})

def four(x): return f'<path d="M{x+12},63 V33 L{x},54 H{x+17}"/>'
def one(x): return f'<path d="M{x+2},39 L{x+9},33 V63"/>'
def links(a, b, n):
    (ax, ay), (bx, by) = a, b
    deg = math.degrees(math.atan2(by-ay, bx-ax)); out = ''
    for i in range(n):
        t = (i + 0.5) / n; x, y = ax+(bx-ax)*t, ay+(by-ay)*t
        out += f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="5" ry="3" transform="rotate({deg:.1f} {x:.1f} {y:.1f})"/>'
    return out
BILL, BILL_D, BILL_L = '#2e8b4f', '#145c2c', '#c9ecd2'
EMBLEMS.update({
 'century': f'''<g transform="rotate(-10 48 48)"><rect x="19" y="33" width="58" height="30" rx="3" fill="{BILL}" stroke="{BILL_D}" stroke-width="2"/>
  <rect x="23" y="37" width="50" height="22" rx="1.5" fill="none" stroke="{BILL_L}" stroke-width="1.3"/>
  <g transform="translate(48 48) scale(0.44) translate(-28.5 -48)" fill="none" stroke="{PAPER}" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round">{one(0)}{zero(17)}{zero(41)}</g></g>''',
 'ball-and-chain': f'''<circle cx="27" cy="28" r="7" fill="none" stroke="{GREY_D}" stroke-width="4"/>
  <g fill="none" stroke="{WIRE}" stroke-width="2.6">{links((31,33),(49,50),3)}</g>
  <circle cx="59" cy="59" r="15.500" fill="{WIRE}" stroke="#1c1f22" stroke-width="2"/>
  <path d="M50,54 a10,10 0 0 1 8,-6" fill="none" stroke="{GREY}" stroke-width="2.5" stroke-linecap="round"/>''',
 'child-labor': f'''<g transform="rotate(35 48 48)"><rect x="45.500" y="28" width="5" height="48" rx="2" fill="#a8622a" stroke="#5a3413" stroke-width="2"/>
  <path d="M19,43 Q48,15 77,43 Q48,29 19,43 Z" fill="{GREY}" stroke="{GREY_D}" stroke-width="2.2" stroke-linejoin="round"/>
  <rect x="43.500" y="24" width="9" height="9" rx="1.5" fill="{GREY}" stroke="{GREY_D}" stroke-width="2"/></g>''',
 'four-hundred': f'<g transform="translate(48 48) scale(0.88) translate(-48.5 -48)" fill="none" stroke="{INK}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">{four(14)}{zero(41)}{zero(65)}</g>',
})

PURPLE, PURPLE_D, LENS, LIQ, WOOD, WOOD_D = '#7b3fb5', '#4a2175', '#8fc3ea', '#35b36a', '#a8622a', '#5a3413'
def seven(x): return f'<path d="M{x+2.2},42.500 H{x+6.6} L{x+3.6},50"/>'
EMBLEMS.update({
 'go-big-or-go-home': f'''<path d="M60,56 H67 V36" fill="none" stroke="{GREY_D}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="67" cy="33" r="4.500" fill="{RED}" stroke="{RED_D}" stroke-width="1.5"/>
  <rect x="26" y="25" width="34" height="48" rx="7" fill="{RED}" stroke="{RED_D}" stroke-width="2"/>
  <rect x="30" y="38" width="26" height="16" rx="1.5" fill="{PAPER}" stroke="{RED_D}" stroke-width="1.5"/>
  <path d="M38.700,38 V54 M47.300,38 V54" fill="none" stroke="{RED_D}" stroke-width="1.2"/>
  <g fill="none" stroke="{RED}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">{seven(30)}{seven(38.7)}{seven(47.3)}</g>
  <circle cx="43" cy="31.500" r="2.500" fill="{GOLD}"/>
  <rect x="35" y="61" width="16" height="5" rx="2" fill="{RED_D}"/>''',
 'spectator': f'''<g fill="{WIRE}" stroke="#1c1f22" stroke-width="1.5" stroke-linejoin="round">
  <path d="M25,52 L29,31 H39 L43,52 Z"/><path d="M53,52 L57,31 H67 L71,52 Z"/>
  <rect x="28" y="25" width="12" height="7" rx="2"/><rect x="56" y="25" width="12" height="7" rx="2"/><rect x="41" y="39" width="14" height="9" rx="2"/></g>
  <g fill="{LENS}" stroke="{WIRE}" stroke-width="4.500"><circle cx="34" cy="56" r="12.500"/><circle cx="62" cy="56" r="12.500"/></g>
  <path d="M27.500,55 a7,7 0 0 1 5,-5.500 M55.500,55 a7,7 0 0 1 5,-5.500" fill="none" stroke="{PAPER}" stroke-width="2.2" stroke-linecap="round"/>''',
 'chemistry': f'''<path d="M35,28 V66 a5,5 0 0 0 5,5 H56 a5,5 0 0 0 5,-5 V28 Z" fill="{PAPER}" fill-opacity="0.6"/>
  <path d="M35,49 H61 V66 a5,5 0 0 1 -5,5 H40 a5,5 0 0 1 -5,-5 Z" fill="{LIQ}"/>
  <g fill="none" stroke="{GREY_D}" stroke-linecap="round" stroke-linejoin="round"><path d="M31,28 H65 M35,28 V66 a5,5 0 0 0 5,5 H56 a5,5 0 0 0 5,-5 V28" stroke-width="3"/>
  <path d="M54,37 H60 M54,45 H60 M54,57 H60 M54,64 H60" stroke-width="1.6"/></g>
  <g fill="{PAPER}" stroke="{LIQ}" stroke-width="1.6"><circle cx="43" cy="42" r="3"/><circle cx="49" cy="34" r="2.2"/></g>''',
 'exact-tie': f'''<g fill="{PURPLE}" stroke="{PURPLE_D}" stroke-width="2.2" stroke-linejoin="round">
  <path d="M44,33 H52 L58,62 L48,74 L38,62 Z"/><path d="M41,23 H55 L52,33 H44 Z"/></g>''',
 'hammer-time': f'''<g transform="translate(96 0) scale(-1 1) translate(-1 4.5) rotate(-70 48 48)"><rect x="45.500" y="32" width="5" height="45" rx="2" fill="{WOOD}" stroke="{WOOD_D}" stroke-width="2"/>
  <g transform="translate(48 30) scale(0.8) translate(-48 -30)" fill="{GREY}" stroke="{GREY_D}" stroke-width="2.75" stroke-linejoin="round"><path d="M58,24 Q72,23 75,36 Q68,30 58,35 Z"/>
  <rect x="35" y="23" width="25" height="13" rx="2"/><rect x="28" y="21" width="8" height="17" rx="2"/></g></g>''',
})
def svg(key, attrs=''):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" {attrs}>'
            f'<circle cx="48" cy="48" r="46" fill="{RIM}"/><circle cx="48" cy="48" r="42" fill="{GOLD}"/>'
            f'<circle cx="48" cy="48" r="38" fill="none" stroke="{RING}" stroke-width="1.5"/>{EMBLEMS[key]}</svg>')
os.makedirs(OUT, exist_ok=True)
for k in EMBLEMS:
    with open(os.path.join(OUT, k + '.svg'), 'w') as f:
        f.write(svg(k) + '\n')
print(f'wrote {len(EMBLEMS)} badges to {OUT}')

# The iOS app's copies (iOS 1.2.7): one imageset per badge in Misc.xcassets/Badges (a
# namespace: Image("Badges/<id>")), the same bytes with the vector data kept
# (server/game/__tests__/badges.test.js holds the two sets to each other)
import json, shutil
IOS = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'iOSClient', 'BABOnline', 'Resources', 'Misc.xcassets', 'Badges'))
INFO = {'author': 'xcode', 'version': 1}
def write_json(path, data):
    with open(path, 'w') as f:
        f.write(json.dumps(data, indent=2).replace('": ', '" : ') + '\n')
os.makedirs(IOS, exist_ok=True)
for name in os.listdir(IOS):
    if name.endswith('.imageset') and name[:-len('.imageset')] not in EMBLEMS:
        shutil.rmtree(os.path.join(IOS, name))
write_json(os.path.join(IOS, 'Contents.json'), {'info': INFO, 'properties': {'provides-namespace': True}})
for k in EMBLEMS:
    d = os.path.join(IOS, k + '.imageset')
    os.makedirs(d, exist_ok=True)
    shutil.copyfile(os.path.join(OUT, k + '.svg'), os.path.join(d, k + '.svg'))
    write_json(os.path.join(d, 'Contents.json'), {'images': [{'filename': k + '.svg', 'idiom': 'universal'}], 'info': INFO,
                                                  'properties': {'preserves-vector-representation': True}})
print(f'wrote {len(EMBLEMS)} badges to {IOS}')
