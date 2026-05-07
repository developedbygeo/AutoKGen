#!/bin/bash
# Run graph analysis algorithms

echo "========================================"
echo "Graph Analysis"
echo "========================================"

DATA_DIR="$DATA_DIR"

# Source provider abstraction
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/provider.sh"

run_provider "Analyze the knowledge graph structure. Write TypeScript code that:

1. Use MCP 'read_query' tool to run these analyses:

   a) Find central nodes (most connections):
      MATCH (n)-[r]-()
      RETURN n, labels(n) as type, count(r) as degree
      ORDER BY degree DESC
      LIMIT 20

   b) Find communities/clusters:
      MATCH (n)-[r]-(m)
      WHERE labels(n) = labels(m)
      RETURN labels(n) as type, count(DISTINCT n) as nodes, count(r) as connections
      
   c) Find bridges (nodes connecting different communities):
      MATCH (n)-[]-(m)
      WHERE labels(n) <> labels(m)
      RETURN n, labels(n), labels(m), count(*) as bridge_count
      ORDER BY bridge_count DESC
      LIMIT 20

   d) Find isolated nodes:
      MATCH (n)
      WHERE NOT (n)-[]-()
      RETURN labels(n) as type, count(n) as isolated_count

   e) Calculate graph density:
      MATCH (n)
      WITH count(n) as nodeCount
      MATCH ()-[r]->()
      WITH nodeCount, count(r) as relCount
      RETURN relCount * 1.0 / (nodeCount * (nodeCount - 1)) as density

2. Generate insights report:
   {
     centralNodes: [...],
     communities: [...],
     bridges: [...],
     isolatedNodes: {...},
     metrics: {
       density: number,
       avgDegree: number,
       maxDegree: number
     },
     recommendations: [
       'Consider connecting isolated nodes',
       'Community X is highly connected',
       etc.
     ]
   }

3. Save to '$OUTPUT_DIR/graph-analysis.json'
4. Print human-readable summary with key insights
5. Suggest actions based on findings

Execute after writing."

echo ""
echo "Analysis complete! Check $OUTPUT_DIR/graph-analysis.json"
echo ""