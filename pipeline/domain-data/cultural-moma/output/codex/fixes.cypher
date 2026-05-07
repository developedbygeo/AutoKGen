// Ontology validation fixes generated at 2026-04-02T11:47:36.070Z
// Ontology: Europeana Data Model (EDM) vocabulary v5.2.4

// SAFE FIXES
// structure | orphaned_nodes | safe
// Review orphaned nodes before reconnecting or deleting them.
MATCH (n) WHERE NOT (n)--() RETURN n.id, labels(n), properties(n) LIMIT 50;

// structure | missing_core_class_instances | safe
// Compare populated labels with core classes derived from the ontology mapping guide.
MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY count DESC;

// MODERATE FIXES
// DESTRUCTIVE FIXES
// structure | orphaned_nodes | destructive
// Delete disconnected nodes that have no valid place in the graph.
// Destructive: uncomment only after review
// MATCH (n) WHERE NOT (n)--() DELETE n;
