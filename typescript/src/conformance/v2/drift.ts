/**
 * The drift guard of the engine v2 converter port (`tasks/v2-profile-plan.md` step 13): every
 * `throw new X(` in n8n's converter and validator sources must be mapped in `V2_REFUSALS`
 * (`compiler/analysis/engine-v2/refusals.ts`), and every entry there must still name a throw.
 *
 * It reads source **text** handed in by the caller — `tasks/v2-acceptance.mts` and a suite that
 * finds a checkout at the pin — so nothing under `src/` reads `.n8n` (decision 15).
 */
import { V2_REFUSALS } from '../../compiler/index.js';
import type { V2Refusal, V2RefusalFile, V2RefusalSite } from '../../compiler/index.js';

/** One `throw new X(…)` in a source file. */
export interface ThrowSite {
  readonly file: V2RefusalFile;
  /** The class thrown. */
  readonly error: string;
  /** 1-based line of the `throw`. */
  readonly line: number;
  /** The text from `throw` to its closing parenthesis. */
  readonly text: string;
}

/** Every `throw new X(…)` in `text`, with the balanced argument list it closes. */
export function throwSitesIn(file: V2RefusalFile, text: string): ThrowSite[] {
  const sites: ThrowSite[] = [];
  const re = /throw\s+new\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    sites.push({
      file, error: m[1]!, line: text.slice(0, m.index).split('\n').length, text: text.slice(m.index, i),
    });
  }
  return sites;
}

/** What {@link refusalDrift} found. Clean when all three lists are empty. */
export interface RefusalDrift {
  /** Every site found, with the entry it matched (`null`: none, or several). */
  readonly sites: readonly { readonly site: ThrowSite; readonly entry: V2RefusalSite | null }[];
  /** Sites no entry matches, or more than one does. */
  readonly unmapped: readonly ThrowSite[];
  /** Entries no site matches, or more than one site does. */
  readonly stale: readonly V2RefusalSite[];
  /** Files the guard was given no text for. */
  readonly missing: readonly V2RefusalFile[];
}

const matches = (entry: V2Refusal, site: ThrowSite): boolean =>
  entry.file === site.file && entry.error === site.error && site.text.includes(entry.match);

/** Checks `sources` (file name → text) against `V2_REFUSALS`, both ways. */
export function refusalDrift(sources: Partial<Readonly<Record<V2RefusalFile, string>>>): RefusalDrift {
  const keys = Object.keys(V2_REFUSALS) as V2RefusalSite[];
  const files = [...new Set(keys.map((k) => V2_REFUSALS[k].file))];
  const missing = files.filter((f) => sources[f] === undefined);
  const all = files.flatMap((f) => (sources[f] === undefined ? [] : throwSitesIn(f, sources[f]!)));
  const sites = all.map((site) => {
    const hits = keys.filter((k) => matches(V2_REFUSALS[k], site));
    return { site, entry: hits.length === 1 ? hits[0]! : null };
  });
  const stale = keys.filter((k) => sources[V2_REFUSALS[k].file] !== undefined
    && all.filter((site) => matches(V2_REFUSALS[k], site)).length !== 1);
  return { sites, unmapped: sites.filter((s) => s.entry === null).map((s) => s.site), stale, missing };
}
