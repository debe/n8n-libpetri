/**
 * The register's vocabulary: what an attribution can say, the constructors every rule set
 * builds one with, and {@link firstMatch}, which evaluates a rule list in its order of
 * specificity.
 */

/**
 * Why a difference is not a defect — or that nothing covers it.
 *
 * - `divergence`: a registered row explains it, and `mechanism` names how. The register's row
 *   **#5** is the umbrella for order: n8n's total order is a LIFO artifact of a stack it
 *   `unshift`s onto and `shift`s from, and this project uses, in place of the total-order
 *   assertion, data equivalence plus happens-before (`docs/divergences.md` #5,
 *   `docs/conformance-m2.md` attributes its two order failures the same way). So an
 *   *order-only* difference — data equal, happens-before intact — is attributed to #5, and the
 *   mechanism that produced it is named separately: #11 and #12 are the two mechanisms already
 *   in the register, and anything else is `novel: true`, which the report lists as a finding
 *   for the register even though the gate passes.
 * - `concurrency`: at k > 1 two independent activations were left unordered, and either
 *   order is correct.
 * - `unattributed`: a finding; the gate fails on it.
 */
export type Attribution =
  | { readonly kind: 'divergence'; readonly row: number; readonly mechanism: string; readonly novel: boolean; readonly why: string }
  | { readonly kind: 'concurrency'; readonly why: string }
  | { readonly kind: 'unattributed'; readonly why: string };

/**
 * The {@link Attribution} of a data difference: never `concurrency`. The budget may reorder
 * activations, never change what one produced, and a registered row excuses the abandonment
 * of an n8n behaviour, never a node's result.
 */
export type DataAttribution = Exclude<Attribution, { readonly kind: 'concurrency' }>;

/** A registered row explains the difference. */
export type Divergence = Extract<Attribution, { readonly kind: 'divergence' }>;

/** Nothing covers the difference: a finding. */
export type Unattributed = Extract<Attribution, { readonly kind: 'unattributed' }>;

export function divergence(row: number, mechanism: string, why: string, novel = false): Divergence {
  return { kind: 'divergence', row, mechanism, novel, why };
}

export function unattributed(why: string): Unattributed {
  return { kind: 'unattributed', why };
}

/** One rule of a rule set: the attribution it makes, or `null` when it does not apply. */
export type Rule<I, A> = (input: I) => A | null;

/** The attribution of the first rule in `rules` that applies to `input`, or `null`. */
export function firstMatch<I, A>(rules: readonly Rule<I, A>[], input: I): A | null {
  for (const rule of rules) {
    const found = rule(input);
    if (found !== null) return found;
  }
  return null;
}
