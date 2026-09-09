"""Generates `fanout-{light,dark}.svg`, the animated fan-out timeline in the README.

Every bar is a real n8n task. Node, start and duration are read off n8n's own per-task clock in
the captures `scripts/testbed/diff-engines.sh` leaves under `.testbed/runs/` — a run, so it is
gitignored, and this script is the only place its numbers enter the repository. Nothing here is
typed by hand: the totals, the ratio, the tick count and the "n8n is still on X" note are all
derived, so re-measuring rewrites the sentences too. Re-measure and regenerate together:

    scripts/testbed/diff-engines.sh --repeat=2 --budgets=1,4
    python3 docs/img/gen-fanout.py

Two properties the animation has to keep:

* **1:1 with the clock it draws.** The point is the three and a half seconds n8n spends after
  the net has already finished, and a sped-up timeline gives that away for free.
* **A finished chart when nothing animates.** Every animated element's *base* style is its final
  state, so a viewer with no CSS animation — or with `prefers-reduced-motion` — sees the complete
  picture rather than an empty one. Only the playhead hides, because a frozen playhead is a claim
  about a moment that is not being shown.
"""
import io
import json
from pathlib import Path

RUNS = Path(__file__).resolve().parents[2] / '.testbed' / 'runs'
CAPTURE = 'concurrency-showcase'
LEGS = (('legacy', 'n8n’s stack loop', 'one node at a time'),
        ('libpetri-k4', 'the same workflow on the net', 'k = 4'))
HAIRLINE_MS = 60          # under this a bar has no width to label at any honest scale
LABEL_PX_PER_CHAR = 7.4   # 13px semibold, over-estimated: a late label beats one over the lane
HOLD_MS = 1600            # the pause on the finished chart before the loop restarts

W, PAD = 1240, 36
PLOT_W = W - 2 * PAD
BAR_H, PITCH = 26, 32
TITLE_Y, SUB_Y, AXIS_Y, GRID_Y0 = 50, 76, 110, 118
HEADS = {'legacy': 136, 'libpetri-k4': 214}
TRACKS = {'legacy': 152, 'libpetri-k4': 230}
LANE_H = {'legacy': BAR_H, 'libpetri-k4': 3 * PITCH + BAR_H}
# The lead line sits inside its own lane's band: above the pill for the single-track lane,
# below it for the four-track one, so neither spills into the other lane.
LEAD_DY = {'legacy': -26, 'libpetri-k4': 35}
GRID_Y1 = TRACKS['libpetri-k4'] + LANE_H['libpetri-k4'] + 10

LIGHT = """
    .bg{fill:#ffffff}.ink{fill:#101330}.muted{fill:#5c6370}.faint{fill:#8b93a1}
    .lane{fill:#f7f7f8;stroke:#e9eaee}.grid{stroke:#e4e5e9}.rule{stroke:#e4e5e9}
    .work{fill:#1f6feb}.onbar{fill:#ffffff}.tick{fill:#8b93a1}
    .pill0{fill:#eef0f4;stroke:#d5d9e1}.pill0t{fill:#101330}.fin0{stroke:#8b93a1}
    .pill1{fill:#1f6feb;stroke:#1f6feb}.pill1t{fill:#ffffff}.fin1{stroke:#1f6feb}
    .head{stroke:#ea4b71}.headd{fill:#ea4b71}
"""
DARK = """
    .bg{fill:#0d1117}.ink{fill:#e6edf3}.muted{fill:#a8b2c0}.faint{fill:#79828f}
    .lane{fill:#161b22;stroke:#232932}.grid{stroke:#232932}.rule{stroke:#232932}
    .work{fill:#4a8ff0}.onbar{fill:#07101d}.tick{fill:#79828f}
    .pill0{fill:#1c222b;stroke:#2f3742}.pill0t{fill:#e6edf3}.fin0{stroke:#79828f}
    .pill1{fill:#4a8ff0;stroke:#4a8ff0}.pill1t{fill:#07101d}.fin1{stroke:#4a8ff0}
    .head{stroke:#ff6b8b}.headd{fill:#ff6b8b}
"""


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def read(leg):
    """One capture as `(wall clock, rows)`, each row a task with its packed track."""
    raw = json.loads((RUNS / f'{CAPTURE}.{leg}.json').read_text(encoding='utf-8'))
    run_data = raw['execution']['data']['resultData']['runData']
    origin = min(t['startTime'] for tasks in run_data.values() for t in tasks)
    rows = sorted(({'node': node, 'start': t['startTime'] - origin, 'dur': t['executionTime'],
                    'idx': t['executionIndex']}
                   for node, tasks in run_data.items() for t in tasks),
                  key=lambda r: r['idx'])
    # Greedy packing in start order: the first track free at this start, else a new one. n8n's
    # loop packs into one track by construction; the net needs as many as it actually ran wide.
    ends = []
    for row in rows:
        track = next((i for i, end in enumerate(ends) if end <= row['start']), len(ends))
        if track == len(ends):
            ends.append(0)
        ends[track] = row['start'] + row['dur']
        row['track'] = track
    return raw['elapsedMs'], rows


def build(palette, ctx):
    """One variant. Body and keyframes are collected first, because the header carries the CSS."""
    px = lambda t: PAD + t * ctx['scale']
    pct = lambda t: round(min(t, ctx['cycle']) / ctx['cycle'] * 100, 3)
    body, keys, rules, n = [], [], [], 0

    for t in range(0, ctx['t_max'] + 1, 1000):
        x = px(t)
        body.append(f'<line class="grid" x1="{x:.1f}" y1="{GRID_Y0}" x2="{x:.1f}" y2="{GRID_Y1}" stroke-width="1"/>')
        body.append(f'<text class="faint tickl" x="{x:.1f}" y="{AXIS_Y}" text-anchor="middle">'
                    f'{"0" if t == 0 else f"{t // 1000} s"}</text>')

    for slot, (leg, title, note) in enumerate(LEGS):
        elapsed, rows = ctx['legs'][leg]
        top = TRACKS[leg]
        body.append(f'<rect class="lane" x="{PAD}" y="{top - 6}" width="{PLOT_W}" height="{LANE_H[leg] + 12}" rx="6"/>')
        body.append(f'<text class="ink h2" x="{PAD}" y="{HEADS[leg]}">{esc(title)}'
                    f'<tspan class="muted" dx="8" font-weight="400">{esc(note)}</tspan></text>')

        # Wide bars first, ticks over them: a tick is an instant, and the node that starts in
        # the same millisecond would otherwise cover it completely.
        for row in sorted(rows, key=lambda r: r['dur'] < HAIRLINE_MS):
            n += 1
            y = top + row['track'] * PITCH
            p0 = pct(row['start'])
            if row['dur'] >= HAIRLINE_MS:
                x, w = px(row['start']), row['dur'] * ctx['scale']
                # scaleX from the bar's own left edge, over exactly the milliseconds it ran.
                body.append(f'<rect class="work an b{n}" x="{x:.1f}" y="{y}" width="{w:.1f}" height="{BAR_H}" rx="4"/>')
                label = f'{esc(row["node"])} · {row["dur"]:,} ms'
                # The label waits until the growing bar is wide enough to hold it, so white text
                # never lands on the lane behind it. LABEL_PX_PER_CHAR over-estimates on purpose.
                held = min((20 + LABEL_PX_PER_CHAR * len(label)) / ctx['scale'], row['dur'] * 0.8)
                body.append(f'<text class="onbar bar an b{n}l" x="{x + 10:.1f}" y="{y + BAR_H // 2 + 5}">{label}</text>')
                keys.append(f'@keyframes k{n}{{0%,{p0}%{{transform:scaleX(0)}}'
                            f'{pct(row["start"] + row["dur"])}%,100%{{transform:scaleX(1)}}}}')
                keys.append(f'@keyframes k{n}l{{0%,{pct(row["start"] + held)}%{{opacity:0}}'
                            f'{pct(row["start"] + held + 120)}%,100%{{opacity:1}}}}')
                rules.append(f'.b{n}{{animation-name:k{n}}} .b{n}l{{animation-name:k{n}l}}')
            else:
                body.append(f'<rect class="tick an b{n}" x="{px(row["start"]) - 1.5:.1f}" y="{y - 5}" '
                            f'width="3" height="{BAR_H + 10}" rx="1.5"/>')
                keys.append(f'@keyframes k{n}{{0%,{p0}%{{opacity:0}}{pct(row["start"] + 30)}%,100%{{opacity:1}}}}')
                rules.append(f'.b{n}{{animation-name:k{n}}}')

        # The wall clock, as a dashed line at the moment the response came back.
        n += 1
        x, mid, label = px(elapsed), top + LANE_H[leg] / 2, f'{elapsed:,} ms'
        w = 20 + 8.3 * len(label)
        body.append(f'''<g class="an b{n}">
    <line class="fin{slot}" x1="{x:.1f}" y1="{GRID_Y0}" x2="{x:.1f}" y2="{GRID_Y1}" stroke-width="1.5" stroke-dasharray="4 4"/>
    <rect class="pill{slot}" x="{x + 9:.1f}" y="{mid - 14:.0f}" width="{w:.0f}" height="28" rx="14" stroke-width="1.25"/>
    <text class="pill{slot}t pill" x="{x + 9 + w / 2:.1f}" y="{mid + 5:.0f}" text-anchor="middle">{label}</text>
    <text class="muted lead" x="{x + 9:.1f}" y="{mid + LEAD_DY[leg]:.0f}">{esc(ctx["lead"][leg])}</text>
  </g>''')
        keys.append(f'@keyframes k{n}{{0%,{pct(elapsed)}%{{opacity:0}}{pct(elapsed + 120)}%,100%{{opacity:1}}}}')
        rules.append(f'.b{n}{{animation-name:k{n}}}')

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {ctx["h"]}" width="{W}" height="{ctx["h"]}"
     role="img" aria-label="{esc(ctx["alt"])}">
  <title>{esc(ctx["title"])}</title>
  <!-- PALETTE - the only block that differs between the light and dark variants. -->
  <style>
{palette}    text {{ font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }}
    .h1 {{ font-size:20px; font-weight:650; }} .h2 {{ font-size:14.5px; font-weight:650; }}
    .sub {{ font-size:14px; }} .tickl {{ font-size:12px; }} .bar {{ font-size:13px; font-weight:600; }}
    .pill {{ font-size:14.5px; font-weight:700; }} .lead {{ font-size:13px; }} .note {{ font-size:12.5px; }}
    /* Every animated element's base style is its FINAL state, so a renderer that does not
       animate shows the finished chart. Only the playhead hides when nothing moves. */
    .an {{ animation-duration:{ctx["cycle"]}ms; animation-timing-function:linear; animation-iteration-count:infinite; }}
    rect.work.an {{ transform-box:fill-box; transform-origin:left center; }}
    .playhead {{ opacity:0; animation:sweep {ctx["cycle"]}ms linear infinite, showhead {ctx["cycle"]}ms linear infinite; }}
    @keyframes sweep {{ 0%{{transform:translateX(0)}}{pct(ctx["sweep_ms"])}%,100%{{transform:translateX({ctx["sweep_px"]:.1f}px)}} }}
    @keyframes showhead {{ 0%,{pct(ctx["sweep_ms"]) - 0.4}%{{opacity:1}}{pct(ctx["sweep_ms"])}%,100%{{opacity:0}} }}
{chr(10).join("    " + k for k in keys)}
{chr(10).join("    " + r for r in rules)}
    @media (prefers-reduced-motion: reduce) {{ .an, .playhead {{ animation:none; }} }}
  </style>
  <rect class="bg" width="{W}" height="{ctx["h"]}"/>
  <text class="ink h1" x="{PAD}" y="{TITLE_Y}">{esc(ctx["title"])}</text>
  <text class="muted sub" x="{PAD}" y="{SUB_Y}">{esc(ctx["subtitle"])}</text>
  {chr(10).join("  " + line for line in body)}
  <g class="playhead">
    <line class="head" x1="{PAD}" y1="{GRID_Y0 - 6}" x2="{PAD}" y2="{GRID_Y1 + 6}" stroke-width="1.5"/>
    <circle class="headd" cx="{PAD}" cy="{GRID_Y0 - 7}" r="3.5"/>
  </g>
  <line class="rule" x1="{PAD}" y1="{ctx["rule_y"]}" x2="{W - PAD}" y2="{ctx["rule_y"]}" stroke-width="1.25"/>
  <rect class="work" x="{PAD}" y="{ctx["rule_y"] + 13}" width="26" height="12" rx="3"/>
  <text class="muted note" x="{PAD + 34}" y="{ctx["rule_y"] + 23}">{esc(ctx["legend_bar"])}</text>
  <rect class="tick" x="{PAD + 470}" y="{ctx["rule_y"] + 10}" width="3" height="18" rx="1.5"/>
  <text class="muted note" x="{PAD + 484}" y="{ctx["rule_y"] + 23}">{esc(ctx["legend_tick"])}</text>
  <text class="faint note" x="{PAD}" y="{ctx["rule_y"] + 45}">{esc(ctx["footer1"])}</text>
  <text class="faint note" x="{PAD}" y="{ctx["rule_y"] + 65}">{esc(ctx["footer2"])}</text>
</svg>
'''


legs = {leg: read(leg) for leg, _, _ in LEGS}
(a_elapsed, a_rows), (b_elapsed, b_rows) = legs['legacy'], legs['libpetri-k4']
ratio = a_elapsed / b_elapsed
t_max = int(a_elapsed * 1.16 // 1000 + 1) * 1000          # room at the right for the slower pill
ticks = [r for r in a_rows if r['dur'] < HAIRLINE_MS]
wide = len({r['node'] for r in b_rows if r['dur'] >= HAIRLINE_MS})
running = next((r['node'] for r in a_rows if r['start'] <= b_elapsed < r['start'] + r['dur']), None)

ctx = {
    'legs': legs,
    'scale': PLOT_W / t_max,
    't_max': t_max,
    'cycle': a_elapsed + HOLD_MS,
    'sweep_ms': a_elapsed,
    'sweep_px': a_elapsed * PLOT_W / t_max,
    'h': GRID_Y1 + 145,
    'rule_y': GRID_Y1 + 62,
    'title': 'One workflow, one number changed',
    'subtitle': (f'{len(a_rows)} activations either way, identical run data, {ratio:.2f}× the wall clock. '
                 'Real time, 1:1 — n8n’s own per-task clock, from a live server.'),
    'lead': {'legacy': f'{ratio:.2f}× the net’s wall clock',
             'libpetri-k4': f'finished — n8n is still on {running}' if running else 'finished'},
    'legend_bar': f'a node running — the {wide} Code legs sleep 1.2 s each',
    'legend_tick': f'the other {len(ticks)} nodes, {sum(r["dur"] for r in ticks)} ms between them',
    'footer1': ('Concurrency Showcase · 13 nodes seeded into a real n8n editor by scripts/testbed/n8n-testbed.sh · '
                'measured by scripts/testbed/diff-engines.sh --repeat=2 · both legs pass the same data check'),
    'footer2': ('The dashed line is the wall clock, request to response, so the gap after the last bar is the '
                'REST round trip both legs pay. Wide bars grow over the milliseconds they ran; ticks appear when '
                'they fire.'),
    'alt': (f'A timeline of the same 13-node n8n workflow run twice. Under n8n’s stack loop the four 1.2 s Code '
            f'nodes run one after another and the run takes {a_elapsed:,} ms. On the Petri net at k = 4 the same '
            f'four run side by side and the run takes {b_elapsed:,} ms, {ratio:.2f} times faster, with identical '
            f'run data.'),
}

for name, palette in (('light', LIGHT), ('dark', DARK)):
    path = Path(__file__).resolve().parent / f'fanout-{name}.svg'
    io.open(path, 'w', encoding='utf-8').write(build(palette, ctx))
    print(f'{path.name}: {path.stat().st_size:,} bytes')
print(f'legacy {a_elapsed:,} ms · net k=4 {b_elapsed:,} ms · {ratio:.2f}× · '
      f'{max(r["track"] for r in b_rows) + 1} tracks · cycle {ctx["cycle"]:,} ms')
