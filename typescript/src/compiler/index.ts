/**
 * n8n workflow → one libpetri `PetriNet` per execution.
 *
 * Takes a structural description of the workflow (nodes, main connections, and a node-type
 * resolver yielding inputs / outputs / requiredInputs / onError / retry settings) and
 * produces a `CompiledWorkflow`: the net, its cached `PrecompiledNet` program and a
 * `NetMap` (transition ↔ node, place ↔ (node, port)). No n8n runtime dependency.
 *
 * Milestone M1, track A. The emission rule, per-node gadget, join gadget, retry gadget,
 * halt + reap, expression read arcs, unreachable-input seeding and the k-safety check are
 * specified in README.md ("The model").
 */
export {};
