/**
 * `NetMap` as the codec reads it: membership without exceptions (`hasNode`, `tryNode`),
 * the `(node, role, port)` indexes behind `transitionFor` / `placeFor` agreeing with a
 * scan of the declaration-order lists, and the derived place collections of a
 * `CompiledWorkflow` being computed once and shared with every `withActions` rebinding.
 */
import { compile, forwardAllActions } from '../../src/compiler/index.js';
import { ALL, diamond, fanOut4, linear } from '../fixtures/workflows.js';

describe('node membership', () => {
  it('hasNode / tryNode answer without throwing; node() still throws for an unknown name', () => {
    const c = compile(linear);
    expect(c.netMap.hasNode('A')).toBe(true);
    expect(c.netMap.hasNode('Nope')).toBe(false);
    expect(c.netMap.tryNode('A')).toBe(c.netMap.node('A'));
    expect(c.netMap.tryNode('Nope')).toBeUndefined();
    expect(() => c.netMap.node('Nope')).toThrow(/NetMap: unknown node 'Nope'/);
  });
});

describe('role indexes', () => {
  it('transitionFor and placeFor agree with a declaration-order scan on every fixture, with and without a port', () => {
    for (const wf of Object.values(ALL)) {
      const c = compile(wf);
      for (const g of c.netMap.nodes) {
        const transitions = c.netMap.transitionsOf(g.node);
        const roles = new Set(transitions.map((t) => t.role));
        for (const role of roles) {
          expect(c.netMap.transitionFor(g.node, role)).toBe(transitions.find((t) => t.role === role));
          for (const port of [0, 1, 2, 3, 19]) {
            expect(c.netMap.transitionFor(g.node, role, port))
              .toBe(transitions.find((t) => t.role === role && 'port' in t && t.port === port));
          }
        }
        expect(c.netMap.transitionFor(g.node, 'route', 99)).toBeUndefined();
        const places = c.netMap.placesOf(g.node);
        for (const role of new Set(places.map((p) => p.role))) {
          expect(c.netMap.placeFor(g.node, role)).toBe(places.find((p) => p.role === role));
          for (const port of [0, 1, 2, 3, 19]) {
            expect(c.netMap.placeFor(g.node, role, port)).toBe(places.find((p) => p.role === role && p.port === port));
          }
        }
        expect(c.netMap.placeFor(g.node, 'ready', 99)).toBeUndefined();
      }
      expect(c.netMap.transitionFor('Nope', 'run')).toBeUndefined();
      expect(c.netMap.placeFor('Nope', 'in-data')).toBeUndefined();
    }
  });

  it('a ported query never matches an info that carries no port', () => {
    const c = compile(fanOut4);
    // `X_run` carries no port; `X_route_o` does.
    expect(c.netMap.transitionFor('Q', 'run')).toBeDefined();
    expect(c.netMap.transitionFor('Q', 'run', 0)).toBeUndefined();
    expect(c.netMap.transitionFor('Q', 'route', 2)!.name).toBe('id:Q/route_2');
    expect(c.netMap.transitionFor('Q', 'route')!.name).toBe('id:Q/route_0');
  });
});

describe('derived place collections', () => {
  it('are the same arrays on every read and on every withActions rebinding', () => {
    const c = compile(diamond);
    const collections = ['joinInputPlaces', 'joinReadyPlaces', 'edgeDataPlaces', 'runningPlaces'] as const;
    const first = collections.map((k) => c[k]);
    const rebound = c.withActions(forwardAllActions());
    expect(rebound).not.toBe(c);
    collections.forEach((k, n) => {
      expect(c[k]).toBe(first[n]);
      expect(rebound[k]).toBe(first[n]);
    });
    expect(c.joinInputPlaces.map((p) => p.name)).toEqual(['id:Merge/ready_0', 'id:Merge/ready_1']);
    expect(c.runningPlaces.map((p) => p.name)).toEqual(c.netMap.nodes.map((g) => g.running.name));
  });
});
