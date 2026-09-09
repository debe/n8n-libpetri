"""Generates `linkedin-card-{light,dark}.svg`, the 1080x1350 announcement image.

Two things only: an n8n canvas, and the complete gadget one of its nodes compiles to.
Three type sizes, no third band.

The gadget is `gadget.ts` `X_start` / `X_run` / `X_done` for a one-output node on its normal
path, with every arc that path uses:

    X_start: one(X/in) one(_budget) one(X/idle) inhibitor(_halt) -> X/running
    X_run:   one(X/running) -> and( edge token, X/routed, X/idle )
    X_done:  one(X/routed) -> and( _budget, X/done )

Omitted, and said so on the card: the retry, halt, waiting and stopped branches of `X_run`,
the `_pause` inhibitor, and the `xor` over several outputs.
"""
import io
from math import hypot

W, H = 1080, 1350
GY, TOPY = 850, 700                        # gadget centre row, and the row above it
R, BW, BH = 32, 40, 88                     # place radius, transition width and height
SMALL, BODY, TITLE = 17, 19, 44            # the only three type sizes on the card

LIGHT = """
    .bg{fill:#ffffff}.canvas{fill:#f7f7f8;stroke:#e4e5e9}.dot{fill:#d9dae0}
    .card{fill:#ffffff;stroke:#dbdfe7}.cardhi{fill:#ffffff;stroke:#ea4b71}
    .wire{stroke:#b6bcc8;fill:none}.ink{fill:#101330}.muted{fill:#5c6370}.faint{fill:#8b93a1}
    .accent{fill:#ea4b71}.accentS{stroke:#ea4b71;fill:none}.icon{fill:#ccd1da}
    .place{fill:#ffffff;stroke:#7b8496}.shared{fill:#fdf0f3;stroke:#ea4b71}
    .bar{fill:#f5c451;stroke:#b98c14}.tok{fill:#101330}
    .arc{stroke:#7b8496;fill:none}.inhF{fill:#ffffff;stroke:#ea4b71}
    .ahF{fill:#7b8496}.awF{fill:#b6bcc8}.ghost{stroke:#c3c9d4;fill:none}.ghF{fill:#c3c9d4}
"""
DARK = """
    .bg{fill:#0d1117}.canvas{fill:#161b22;stroke:#272d36}.dot{fill:#2b323c}
    .card{fill:#1c222b;stroke:#2f3742}.cardhi{fill:#1c222b;stroke:#ff6b8b}
    .wire{stroke:#4b5563;fill:none}.ink{fill:#e6edf3}.muted{fill:#a8b2c0}.faint{fill:#79828f}
    .accent{fill:#ff6b8b}.accentS{stroke:#ff6b8b;fill:none}.icon{fill:#3a424e}
    .place{fill:#1c222b;stroke:#8b95a5}.shared{fill:#2a1a20;stroke:#ff6b8b}
    .bar{fill:#d8a93c;stroke:#f0cd73}.tok{fill:#e6edf3}
    .arc{stroke:#8b95a5;fill:none}.inhF{fill:#0d1117;stroke:#ff6b8b}
    .ahF{fill:#8b95a5}.awF{fill:#4b5563}.ghost{stroke:#454e5b;fill:none}.ghF{fill:#454e5b}
"""

def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def txt(x, y, s, cls='ink', size=BODY, weight=400, anchor='start', mono=False, ls=None):
    l = f' letter-spacing="{ls}"' if ls else ''
    return (f'<text class="{cls} {"mono" if mono else ""}" x="{x}" y="{y}" text-anchor="{anchor}" '
            f'font-size="{size}" font-weight="{weight}"{l}>{esc(s)}</text>')

def place(x, y, tok=0, shared=False, r=R):
    s = f'<circle class="{"shared" if shared else "place"}" cx="{x}" cy="{y}" r="{r}" stroke-width="2.2"/>'
    if tok == 1:
        s += f'<circle class="tok" cx="{x}" cy="{y}" r="10"/>'
    elif tok == 2:
        s += (f'<circle class="tok" cx="{x-11}" cy="{y}" r="9"/>'
              f'<circle class="tok" cx="{x+11}" cy="{y}" r="9"/>')
    return s

def bar(x, y):
    return (f'<rect class="bar" x="{x-BW//2}" y="{y-BH//2}" width="{BW}" height="{BH}" '
            f'rx="4" stroke-width="1.8"/>')

def edge_of_circle(cx, cy, tx, ty, r=R):
    """The point on a place's rim facing (tx, ty), so no arrow starts inside a shape."""
    d = hypot(tx - cx, ty - cy)
    return (cx + (tx - cx) / d * r, cy + (ty - cy) / d * r)

def elbow_vh(x1, y1, x2, y2, r=16):
    """Vertical out of (x1, y1), one rounded corner, horizontal into (x2, y2)."""
    sy, sx = (1 if y2 > y1 else -1), (1 if x2 > x1 else -1)
    return (f'M{x1} {y1} L{x1} {y2 - sy * r} Q{x1} {y2} {x1 + sx * r} {y2} L{x2} {y2}')

def elbow_hv(x1, y1, x2, y2, r=16):
    """Horizontal out of (x1, y1), one rounded corner, vertical into (x2, y2)."""
    sx, sy = (1 if x2 > x1 else -1), (1 if y2 > y1 else -1)
    return (f'M{x1} {y1} L{x2 - sx * r} {y1} Q{x2} {y1} {x2} {y1 + sy * r} L{x2} {y2}')

def path(d, cls='arc', marker='ah'):
    return f'<path class="{cls}" stroke-width="2.2" marker-end="url(#{marker})" d="{d}"/>'

def arc(x1, y1, x2, y2, curved=False, cls='arc', marker='ah'):
    d = (f'M{x1:.1f} {y1:.1f} C{(x1+x2)/2:.1f} {y1:.1f} {(x1+x2)/2:.1f} {y2:.1f} {x2:.1f} {y2:.1f}'
         if curved else f'M{x1:.1f} {y1:.1f} L{x2:.1f} {y2:.1f}')
    return f'<path class="{cls}" stroke-width="2.2" marker-end="url(#{marker})" d="{d}"/>'

def ncard(x, y, label, hi=False, w=140, h=48):
    return ''.join([
        f'<rect class="{"cardhi" if hi else "card"}" x="{x-w//2}" y="{y-h//2}" width="{w}" '
        f'height="{h}" rx="9" stroke-width="{2.4 if hi else 1.5}"/>',
        f'<rect class="{"accent" if hi else "icon"}" x="{x-w//2+13}" y="{y-8}" width="16" '
        f'height="16" rx="4" stroke="none"/>',
        txt(x + 16, y + 7, label, 'ink', BODY, 600, 'middle')])

def build(palette):
    o = io.StringIO()
    o.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" '
            f'height="{H}" role="img" aria-label="An n8n workflow canvas, and the complete '
            f'Petri net gadget that one of its nodes compiles to: in, idle, running, routed '
            f'and done places, start, run and done transitions, a shared budget place taken '
            f'by start and returned by done, and a halt place inhibiting start.">')
    o.write('<title>Your workflow becomes a Petri net</title>')
    o.write(f'<style>{palette}text{{font-family:Inter,-apple-system,BlinkMacSystemFont,'
            f'"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}}'
            f'.mono{{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}}</style>')
    o.write('<defs>'
            '<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" '
            'orient="auto-start-reverse"><path class="ahF" d="M0 0 L10 5 L0 10 z"/></marker>'
            '<marker id="aw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" '
            'orient="auto-start-reverse"><path class="awF" d="M0 0 L10 5 L0 10 z"/></marker>'
            '<marker id="gh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" '
            'orient="auto-start-reverse"><path class="ghF" d="M0 0 L10 5 L0 10 z"/></marker>'
            '<marker id="inh" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" '
            'orient="auto-start-reverse"><circle class="inhF" cx="6" cy="6" r="4.2" stroke-width="1.5"/>'
            '</marker></defs>')
    o.write(f'<rect class="bg" width="{W}" height="{H}"/>')

    # ---- title -------------------------------------------------------------
    o.write(txt(60, 88, 'N8N-LIBPETRI', 'accent', SMALL, 700, ls='2.4'))
    o.write(txt(60, 152, 'Your workflow becomes a Petri net.', 'ink', TITLE, 700))
    o.write(txt(60, 196, 'n8n keeps the nodes. The net decides what runs.', 'muted', BODY))

    # ---- the canvas --------------------------------------------------------
    o.write('<rect class="canvas" x="60" y="266" width="960" height="176" rx="12" stroke-width="1.5"/>')
    for gx in range(88, 1020, 30):
        for gy in range(292, 442, 30):
            o.write(f'<circle class="dot" cx="{gx}" cy="{gy}" r="1.6"/>')
    cy, cu, cd = 354, 310, 398
    for x1, y1, x2, y2, cv in [(175, cy, 445, cu, True), (175, cy, 445, cd, True),
                               (445, cu, 715, cy, True), (445, cd, 715, cy, True),
                               (715, cy, 920, cy, False)]:
        o.write(arc(x1 + 70, y1, x2 - 70, y2, cv, 'wire', 'aw'))
    o.write(ncard(175, cy, 'Trigger'))
    o.write(ncard(445, cu, 'A', hi=True))
    o.write(ncard(445, cd, 'B'))
    o.write(ncard(715, cy, 'Merge'))
    o.write(ncard(920, cy, 'End'))

    # ---- compiles to -------------------------------------------------------
    o.write(arc(445, 476, 445, 540))
    o.write(txt(468, 518, 'every node compiles to', 'muted', BODY, 600))

    # ---- the gadget --------------------------------------------------------
    IN, START, RUN_P, RUN, ROUTED, DONE_T, DONE_P = 120, 260, 400, 540, 680, 820, 960
    IDLE_X, EDGE_X = 400, 680
    BUD, BUD_Y, HALT, HALT_Y = 540, 1060, 150, 1020
    top, bot, half = GY - BH // 2, GY + BH // 2, BW // 2

    # every arc, endpoints taken from the shapes' rims
    o.write(arc(IN + R, GY, START - half, GY))                              # in -> start
    o.write(arc(START + half, GY, RUN_P - R, GY))                           # start -> running
    o.write(arc(RUN_P + R, GY, RUN - half, GY))                             # running -> run
    o.write(arc(RUN + half, GY, ROUTED - R, GY))                            # run -> routed
    o.write(arc(ROUTED + R, GY, DONE_T - half, GY))                         # routed -> done
    o.write(arc(DONE_T + half, GY, DONE_P - R, GY))                         # done -> X/done
    o.write(path(elbow_hv(IDLE_X - R, TOPY, START, top)))                   # idle -> start
    o.write(path(elbow_vh(RUN - 10, top, IDLE_X + R, TOPY)))                # run -> idle
    o.write(path(elbow_vh(RUN + 10, top, EDGE_X - R, TOPY)))                # run -> edge
    o.write(path(elbow_hv(BUD - R, BUD_Y, START + 12, bot)))                # _budget -> start
    o.write(path(elbow_vh(DONE_T - 10, bot, BUD + R, BUD_Y)))               # done -> _budget
    o.write(path(elbow_hv(HALT + R, HALT_Y, START - 12, bot + 6),
                 'accentS', 'inh'))                                         # _halt -| start
    o.write(arc(EDGE_X + R, TOPY, EDGE_X + 116, TOPY, False, 'ghost', 'gh'))  # on into the next node
    o.write(place(IN, GY, tok=1))
    o.write(place(RUN_P, GY))
    o.write(place(ROUTED, GY))
    o.write(place(DONE_P, GY))
    o.write(place(IDLE_X, TOPY, tok=1))
    o.write(place(EDGE_X, TOPY))
    o.write(place(BUD, BUD_Y, tok=2, shared=True))
    o.write(place(HALT, HALT_Y, shared=True))
    for x in (START, RUN, DONE_T):
        o.write(bar(x, GY))

    for x, lb in [(IN, 'in'), (RUN_P, 'running'), (ROUTED, 'routed'), (DONE_P, 'done')]:
        o.write(txt(x, GY + R + 32, lb, 'muted', BODY, 400, 'middle', mono=True))
    # beside the bars, not above them: the vertical arcs own the corridor over each top
    for x, lb in [(START, 'start'), (RUN, 'run'), (DONE_T, 'done')]:
        o.write(txt(x - 26, top - 12, lb, 'ink', BODY, 700, 'end'))
    o.write(txt(IDLE_X, TOPY - R - 22, 'idle', 'muted', BODY, 400, 'middle', mono=True))
    o.write(txt(EDGE_X, TOPY - R - 22, 'to the next node', 'muted', BODY, 400, 'middle'))
    o.write(txt(BUD, BUD_Y + R + 34, '_budget', 'accent', BODY, 700, 'middle', mono=True))
    o.write(txt(HALT, HALT_Y + R + 34, '_halt', 'accent', BODY, 700, 'middle', mono=True))

    # ---- caption -----------------------------------------------------------
    o.write(txt(60, 1200, 'idle comes back at run, the budget only at done — that gap is the '
                          'node still in flight.', 'muted', BODY))
    o.write(txt(60, 1230, '_budget and _halt are shared by every node. Retry and wait branches '
                          'omitted.', 'faint', BODY))

    # ---- footer ------------------------------------------------------------
    o.write(txt(60, 1306, 'Apache-2.0', 'faint', SMALL, 600))
    o.write(txt(1020, 1306, 'github.com/debe/n8n-libpetri', 'ink', SMALL, 600, 'end', mono=True))
    o.write('</svg>')
    return o.getvalue()

for name, pal in (('light', LIGHT), ('dark', DARK)):
    with open(f'docs/img/linkedin-card-{name}.svg', 'w') as f:
        f.write(build(pal))
    print(f'wrote docs/img/linkedin-card-{name}.svg')
