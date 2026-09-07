"""Generates `empty-token-{light,dark}.svg`.

Every place and transition name is the compiler's own, read off `dotExport()` of the
compiled `diamond` fixture; the behaviour (B skipped, Merge still runs) is what the
scheduler actually does on that fixture. Re-run after changing either.
"""
import io

W, H = 1240, 1012
FX, FW, FH, GAP, FY0 = 36, 1168, 176, 12, 348
CY_OFF, CAP_X = 82, 760
XS = dict(if_run=104, a_in=190, a_run=254, m_in0=342, arm0=408, slot=492,
          b_inE=190, b_skip=254, m_in1E=342, arm1=408, m_start=580, m_run=652)
UP, DN, R0, HD = -36, 36, -54, -18

def place(x, y, tok=None, term=False):
    c = 'term' if term else 'place'
    s = f'<circle class="{c}" cx="{x}" cy="{y}" r="13" stroke-width="1.7"/>'
    if tok == 'data':  s += f'<circle class="tok" cx="{x}" cy="{y}" r="5"/>'
    if tok == 'empty': s += f'<circle class="tokE" cx="{x}" cy="{y}" r="5" stroke-width="1.7"/>'
    return s

def bar(x, y, lit):
    return f'<rect class="{"barLit" if lit else "bar"}" x="{x-10}" y="{y-19}" width="20" height="38" rx="3" stroke-width="1.4"/>'

def seg(x1, y1, x2, y2, lit, curved=False):
    c, m = ('arcLit', 'ahL') if lit else ('arc', 'ah')
    d = (f'M{x1} {y1} C{(x1+x2)/2} {y1} {(x1+x2)/2} {y2} {x2} {y2}' if curved else f'M{x1} {y1} L{x2} {y2}')
    return f'<path class="{c}" stroke-width="1.7" marker-end="url(#{m})" d="{d}"/>'

def lbl(x, y, t, cls='plbl', anchor='middle'):
    return f'<text class="muted {cls}" x="{x}" y="{y}" text-anchor="{anchor}">{t}</text>'

def stage(cy, T, L):
    u, d, g = cy + UP, cy + DN, []
    g += [seg(XS['if_run']+10, cy, XS['a_in']-13, u, 'if' in L, True),
          seg(XS['if_run']+10, cy, XS['b_inE']-13, d, 'if' in L, True),
          seg(XS['a_in']+13, u, XS['a_run']-10, u, 'a' in L),
          seg(XS['a_run']+10, u, XS['m_in0']-13, u, 'a' in L),
          seg(XS['b_inE']+13, d, XS['b_skip']-10, d, 'b' in L),
          seg(XS['b_skip']+10, d, XS['m_in1E']-13, d, 'b' in L),
          seg(XS['m_in0']+13, u, XS['arm0']-10, u, 'arm' in L),
          seg(XS['m_in1E']+13, d, XS['arm1']-10, d, 'arm' in L),
          seg(XS['arm0']+10, u, XS['slot']-13, cy+R0, 'arm' in L, True),
          seg(XS['arm0']+10, u, XS['slot']-13, cy+HD, 'arm' in L, True),
          seg(XS['arm1']+10, d, XS['slot']-13, d, 'arm' in L),
          seg(XS['slot']+13, cy+R0, XS['m_start']-10, cy, 'start' in L, True),
          seg(XS['slot']+13, cy+HD, XS['m_start']-10, cy, 'start' in L, True),
          seg(XS['slot']+13, d, XS['m_start']-10, cy, 'start' in L, True),
          seg(XS['m_start']+10, cy, XS['m_run']-13, cy, 'start' in L)]
    g += [bar(XS['if_run'], cy, 'if' in L),
          place(XS['a_in'], u, T.get('a_in')), bar(XS['a_run'], u, 'a' in L),
          place(XS['m_in0'], u, T.get('m_in0')), bar(XS['arm0'], u, 'arm' in L),
          place(XS['b_inE'], d, T.get('b_inE')), bar(XS['b_skip'], d, 'b' in L),
          place(XS['m_in1E'], d, T.get('m_in1E')), bar(XS['arm1'], d, 'arm' in L),
          place(XS['slot'], cy+R0, T.get('ready_0')), place(XS['slot'], cy+HD, T.get('hasdata')),
          place(XS['slot'], d, T.get('ready_1')),
          bar(XS['m_start'], cy, 'start' in L), place(XS['m_run'], cy, T.get('m_running'), term=True)]
    g += [lbl(XS['if_run'], cy+36, 'IF runs', 'tlbl'),
          lbl(XS['a_in'], u-22, 'to A'), lbl(XS['a_run'], u-22, 'A runs', 'tlbl'),
          lbl(XS['m_in0'], u-22, 'from A'), lbl(XS['arm0'], u-22, 'claim slot 0', 'tlbl'),
          lbl(XS['b_inE'], d+30, 'to B'), lbl(XS['b_skip'], d+30, 'B skips', 'tlbl'),
          lbl(XS['m_in1E'], d+30, 'from B'), lbl(XS['arm1'], d+30, 'claim slot 1', 'tlbl'),
          lbl(XS['slot']+20, cy+R0+4, 'slot 0 ready', 'plbl', 'start'),
          lbl(XS['slot']+20, cy+HD+4, 'has data', 'plbl', 'start'),
          lbl(XS['slot']+20, d+4, 'slot 1 ready', 'plbl', 'start'),
          # dropped below the slot column, which it used to sit on
          lbl(XS['m_start'], cy+62, 'Merge starts', 'tlbl'), lbl(XS['m_run'], cy+62, 'running')]
    return '\n    '.join(g)

FRAMES = [
    dict(n='1', head='IF routes every connected output',
         b1='The branch IF did not take emits an <tspan class="accent">empty</tspan> token,',
         b2='not nothing. Every edge resolves, always.',
         tok={'a_in': 'data', 'b_inE': 'empty'}, lit={'if'}),
    dict(n='2', head='A runs. B never runs.',
         b1='B&#8217;s skip consumes the empty and passes an empty on.',
         b2='Both of Merge&#8217;s inputs are now accounted for.',
         tok={'m_in0': 'data', 'm_in1E': 'empty'}, lit={'a', 'b'}),
    dict(n='3', head='Each arrival claims a slot, then Merge starts',
         b1='The data arrival raises <tspan class="accent">has data</tspan>. The empty one does not.',
         b2='All slots ready and one holds data, so Merge runs.',
         tok={'ready_0': 'data', 'hasdata': 'data', 'ready_1': 'data', 'm_running': 'data'},
         lit={'arm', 'start'}),
]

PALETTE_LIGHT = """    .bg { fill:#ffffff; } .canvas { fill:#f7f7f8; stroke:#e4e5e9; } .dot { fill:#d9dae0; }
    .frame { fill:#fbfbfc; stroke:#e8e9ed; }
    .card { fill:#ffffff; stroke:#dbdfe7; } .glyph { stroke:#6b7280; fill:none; }
    .wire { stroke:#b6bcc8; fill:none; } .wireLit { stroke:#ea4b71; fill:none; }
    .ink { fill:#101330; } .muted { fill:#6b7280; } .faint { fill:#9aa1ae; } .accent { fill:#ea4b71; }
    .place { fill:#ffffff; stroke:#7b8496; } .term { fill:#eaf1fb; stroke:#3b6ea8; }
    .bar { fill:#ffffff; stroke:#9aa1ae; } .barLit { fill:#f5c451; stroke:#b98c14; }
    .tok { fill:#101330; } .tokE { fill:none; stroke:#101330; }
    .arc { stroke:#c4c9d2; fill:none; } .arcLit { stroke:#7b8496; fill:none; }
    .ahF { fill:#c4c9d2; } .ahLF { fill:#7b8496; } .awF { fill:#b6bcc8; }
    .panelln { stroke:#e4e5e9; } .badge { fill:#ea4b71; } .onacc { fill:#ffffff; }
"""
PALETTE_DARK = """    .bg { fill:#0d1117; } .canvas { fill:#12171e; stroke:#2a313a; } .dot { fill:#262d36; }
    .frame { fill:#11161d; stroke:#242b34; }
    .card { fill:#1b222b; stroke:#333c47; } .glyph { stroke:#a9b2bd; fill:none; }
    .wire { stroke:#4d5661; fill:none; } .wireLit { stroke:#ff6b8b; fill:none; }
    .ink { fill:#e9eef4; } .muted { fill:#a9b2bd; } .faint { fill:#7d8794; } .accent { fill:#ff6b8b; }
    .place { fill:#12171e; stroke:#9aa4b1; } .term { fill:#16283d; stroke:#6ea8e8; }
    .bar { fill:#12171e; stroke:#6e7681; } .barLit { fill:#d8a63a; stroke:#f0cd76; }
    .tok { fill:#e9eef4; } .tokE { fill:none; stroke:#e9eef4; }
    .arc { stroke:#39424d; fill:none; } .arcLit { stroke:#9aa4b1; fill:none; }
    .ahF { fill:#39424d; } .ahLF { fill:#9aa4b1; } .awF { fill:#4d5661; }
    .panelln { stroke:#2a313a; } .badge { fill:#ff6b8b; } .onacc { fill:#12060a; }
"""

def build(palette):
    o = [f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img"
     aria-label="An n8n workflow that splits at IF and rejoins at Merge, then three frames of the compiled net running. IF routes data to A and an empty token to B. A runs and B skips, but the skip still delivers an empty to Merge. Both of Merge's input slots are claimed and one carries data, so Merge starts without any stuck-join fallback.">
  <title>The empty token, and why the join never sticks</title>
  <!-- PALETTE - the only block that differs between the light and dark variants. -->
  <style>
{palette}    text {{ font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }}
    .eyebrow {{ font-size:12.5px; font-weight:700; letter-spacing:1.4px; }}
    .nodelbl {{ font-size:13px; font-weight:600; }}
    .plbl {{ font-size:12.5px; }} .tlbl {{ font-size:12.5px; font-weight:600; }}
    .fhead {{ font-size:17px; font-weight:650; }} .fbody {{ font-size:14px; }} .note {{ font-size:13.5px; }}
  </style>
  <defs>
    <marker id="ah"  viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path class="ahF" d="M0 0 L10 5 L0 10 z"/></marker>
    <marker id="ahL" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path class="ahLF" d="M0 0 L10 5 L0 10 z"/></marker>
    <marker id="aw"  viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="awF" d="M0 0 L10 5 L0 10 z"/></marker>
    <pattern id="grid" width="18" height="18" patternUnits="userSpaceOnUse"><circle class="dot" cx="1.6" cy="1.6" r="1.15"/></pattern>
  </defs>
  <rect class="bg" x="0" y="0" width="{W}" height="{H}"/>

  <text class="muted eyebrow" x="36" y="38">THE WORKFLOW YOU DRAW</text>
  <text class="faint note" x="1204" y="38" text-anchor="end">IF takes one branch &#183; B is never reached &#183; Merge still runs</text>
  <rect class="canvas" x="36" y="56" width="1168" height="256" rx="12" stroke-width="1.25"/>
  <rect x="37" y="57" width="1166" height="254" rx="11" fill="url(#grid)"/>
  <g class="wire" stroke-width="1.75" marker-end="url(#aw)">
    <path d="M338 173 C360 173 362 173 382 173"/><path d="M446 161 C472 161 476 103 500 103"/>
    <path d="M564 103 C592 103 596 161 618 161"/><path d="M682 173 C700 173 700 173 718 173"/>
  </g>
  <g class="wireLit" stroke-width="1.75" marker-end="url(#aw)">
    <path d="M446 185 C472 185 476 243 500 243"/><path d="M564 243 C592 243 596 185 618 185"/>
  </g>
  <path class="card" stroke-width="1.4" d="M302 145 h28 a6 6 0 0 1 6 6 v44 a6 6 0 0 1 -6 6 h-28 a28 28 0 0 1 0 -56 z"/>
  <g class="glyph" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M316 159 l-7 12 h6 l-3 10 l8 -12 h-6 z"/></g>
  <text class="ink nodelbl" x="319" y="219" text-anchor="middle">Trigger</text>
  <rect class="card" x="386" y="145" width="60" height="56" rx="7" stroke-width="1.4"/>
  <g class="glyph" stroke-width="1.6" stroke-linecap="round"><path d="M404 185 h6 l12 -24 h6"/><path d="M404 173 h24"/></g>
  <text class="ink nodelbl" x="416" y="219" text-anchor="middle">IF</text>
  <rect class="card" x="504" y="75" width="60" height="56" rx="7" stroke-width="1.4"/>
  <g class="glyph" stroke-width="1.6" stroke-linecap="round"><path d="M522 113 l18 -18 l6 6 l-18 18 h-6 z"/></g>
  <text class="ink nodelbl" x="534" y="149" text-anchor="middle">A</text>
  <rect class="card" x="504" y="215" width="60" height="56" rx="7" stroke-width="1.4" stroke-dasharray="4 3"/>
  <g class="glyph" stroke-width="1.6" stroke-linecap="round" opacity="0.4"><path d="M522 253 l18 -18 l6 6 l-18 18 h-6 z"/></g>
  <text class="faint nodelbl" x="534" y="289" text-anchor="middle">B (skipped)</text>
  <rect class="card" x="622" y="145" width="60" height="56" rx="7" stroke-width="1.4"/>
  <g class="glyph" stroke-width="1.6" stroke-linecap="round"><path d="M638 161 h10 l8 12 h10"/><path d="M638 185 h10 l8 -12"/></g>
  <text class="ink nodelbl" x="652" y="219" text-anchor="middle">Merge</text>
  <rect class="card" x="722" y="145" width="46" height="56" rx="7" stroke-width="1.4"/>
  <g class="glyph" stroke-width="1.6" stroke-linecap="round"><path d="M736 173 l18 -18 l6 6 l-18 18 h-6 z"/></g>
  <text class="ink nodelbl" x="745" y="219" text-anchor="middle">End</text>''']

    for i, f in enumerate(FRAMES):
        fy = FY0 + i * (FH + GAP)
        cy = fy + CY_OFF
        o.append(f'''
  <rect class="frame" x="{FX}" y="{fy}" width="{FW}" height="{FH}" rx="12" stroke-width="1.25"/>
  <circle class="badge" cx="{CAP_X+13}" cy="{cy-38}" r="13"/>
  <text class="onacc" x="{CAP_X+13}" y="{cy-33}" text-anchor="middle" font-size="14" font-weight="700">{f['n']}</text>
  <text class="ink fhead" x="{CAP_X+38}" y="{cy-33}">{f['head']}</text>
  <text class="muted fbody" x="{CAP_X}" y="{cy+2}">{f['b1']}</text>
  <text class="muted fbody" x="{CAP_X}" y="{cy+24}">{f['b2']}</text>
    {stage(cy, f['tok'], f['lit'])}''')

    o.append(f'''
  <line class="panelln" stroke-width="1.25" x1="36" y1="914" x2="1204" y2="914"/>
  <circle class="place" cx="46" cy="940" r="10" stroke-width="1.6"/>
  <text class="muted note" x="62" y="944">place: holds tokens</text>
  <rect class="bar" x="216" y="930" width="14" height="20" rx="2" stroke-width="1.3"/>
  <text class="muted note" x="238" y="944">transition: fires, moving tokens</text>
  <rect class="barLit" x="452" y="930" width="14" height="20" rx="2" stroke-width="1.3"/>
  <text class="muted note" x="474" y="944">just fired</text>
  <circle class="place" cx="576" cy="940" r="10" stroke-width="1.6"/><circle class="tok" cx="576" cy="940" r="4"/>
  <text class="muted note" x="592" y="944">data token</text>
  <circle class="place" cx="686" cy="940" r="10" stroke-width="1.6"/><circle class="tokE" cx="686" cy="940" r="4" stroke-width="1.6"/>
  <text class="muted note" x="702" y="944">empty token</text>
  <text class="faint note" x="36" y="972">to A: A/in &#183; to B: B/in_empty &#183; from A: in0_e0 &#183; from B: in1_e5_empty &#183; claim slot 0: arm_e0_data &#183; claim slot 1: arm_e5_empty</text>
  <text class="faint note" x="36" y="994">slot i ready: ready_i &#183; has data: hasdata &#183; running: Merge/running. Compiler names, read off dotExport() of the compiled diamond fixture.</text>
</svg>''')
    return '\n'.join(o)

for name, pal in (('light', PALETTE_LIGHT), ('dark', PALETTE_DARK)):
    io.open(f'empty-token-{name}.svg', 'w', encoding='utf-8').write(build(pal))
    print(f'empty-token-{name}.svg')
