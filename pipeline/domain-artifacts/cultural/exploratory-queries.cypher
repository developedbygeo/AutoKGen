// =============================================================================
// Cultural Heritage Knowledge Graph — Graph-Returning Exploratory Queries
// For Neo4j Browser visualization (use RETURN * for graph rendering)
// =============================================================================


// ---------------------------------------------------------------------------
// 1. SINGLE ARTIST UNIVERSE
// Picasso's works fanning out to all entity types — the classic star pattern
// ---------------------------------------------------------------------------
MATCH (cho:ProvidedCHO)-[r1:`dc:creator`]->(a:Agent {`foaf:name`: 'Pablo Picasso'})
WITH cho, a, r1 LIMIT 8
OPTIONAL MATCH (cho)-[r2:`dcterms:temporal`]->(t:TimeSpan)
OPTIONAL MATCH (cho)-[r3:`edm:currentLocation`]->(p:Place)
OPTIONAL MATCH (cho)-[r4:`dc:type`]->(c:Concept)
OPTIONAL MATCH (a)-[r5:`edm:hasMet`]->(ap:Place)
RETURN *;


// ---------------------------------------------------------------------------
// 2. MULTI-ARTIST TIME SLICE
// All artists and their works from a single year — shows who was active in 1937
// ---------------------------------------------------------------------------
MATCH (cho:ProvidedCHO)-[r1:`dc:creator`]->(a:Agent),
      (cho)-[r2:`dcterms:temporal`]->(t:TimeSpan {`skos:prefLabel`: '1937'})
WITH cho, a, t, r1, r2 LIMIT 15
OPTIONAL MATCH (a)-[r3:`edm:hasMet`]->(p:Place)
RETURN *;


// ---------------------------------------------------------------------------
// 3. NATIONALITY ECOSYSTEM
// French artists, their works, and what types they created
// ---------------------------------------------------------------------------
MATCH (a:Agent)-[r1:`edm:hasMet`]->(p:Place {`skos:prefLabel`: 'French'})
WITH a, p, r1 LIMIT 12
MATCH (cho:ProvidedCHO)-[r2:`dc:creator`]->(a)
WITH a, p, r1, cho, r2 LIMIT 30
OPTIONAL MATCH (cho)-[r3:`dc:type`]->(c:Concept)
RETURN *;


// ---------------------------------------------------------------------------
// 4. FULL EDM STAR
// Artworks connected to ALL 5 entity types simultaneously — best screenshot
// ---------------------------------------------------------------------------
MATCH (cho:ProvidedCHO)-[r1:`dc:creator`]->(a:Agent),
      (cho)-[r2:`edm:currentLocation`]->(p:Place),
      (cho)-[r3:`dcterms:temporal`]->(t:TimeSpan),
      (cho)-[r4:`dc:type`]->(c1:Concept),
      (cho)-[r5:`dcterms:isPartOf`]->(c2:Concept)
WHERE c1 <> c2
RETURN * LIMIT 5;


// ---------------------------------------------------------------------------
// 5. CROSS-ARTIST BRIDGE
// Picasso and Matisse linked through shared art type (Concept as bridge)
// ---------------------------------------------------------------------------
MATCH (a1:Agent {`foaf:name`: 'Pablo Picasso'})<-[r1:`dc:creator`]-(cho1:ProvidedCHO)-[r2:`dc:type`]->(c:Concept)<-[r3:`dc:type`]-(cho2:ProvidedCHO)-[r4:`dc:creator`]->(a2:Agent {`foaf:name`: 'Henri Matisse'})
RETURN * LIMIT 10;


// ---------------------------------------------------------------------------
// 6. TEMPORAL NEIGHBOURHOOD
// A single time period and everything radiating from it
// ---------------------------------------------------------------------------
MATCH (cho:ProvidedCHO)-[r1:`dcterms:temporal`]->(t:TimeSpan {`skos:prefLabel`: '1950'})
WITH cho, t, r1 LIMIT 10
OPTIONAL MATCH (cho)-[r2:`dc:creator`]->(a:Agent)
OPTIONAL MATCH (cho)-[r3:`dc:type`]->(c:Concept)
OPTIONAL MATCH (cho)-[r4:`edm:currentLocation`]->(p:Place)
RETURN *;


// ---------------------------------------------------------------------------
// 7. CONCEPT HUB
// A single art type and all the artworks + artists connected to it
// ---------------------------------------------------------------------------
MATCH (cho:ProvidedCHO)-[r1:`dc:type`]->(c:Concept {`dc:identifier`: 'Painting & Sculpture'})
WITH cho, c, r1 LIMIT 12
MATCH (cho)-[r2:`dc:creator`]->(a:Agent)
OPTIONAL MATCH (a)-[r3:`edm:hasMet`]->(p:Place)
RETURN *;


// ---------------------------------------------------------------------------
// 8. DIAMOND PATTERN
// Two artists from the same nationality who both created the same art type
// ---------------------------------------------------------------------------
MATCH (a1:Agent)-[r1:`edm:hasMet`]->(p:Place)<-[r2:`edm:hasMet`]-(a2:Agent)
WHERE a1.`foaf:name` = 'Pablo Picasso' AND a2.`foaf:name` = 'Joan Miró'
MATCH (cho1:ProvidedCHO)-[r3:`dc:creator`]->(a1)
MATCH (cho2:ProvidedCHO)-[r4:`dc:creator`]->(a2)
MATCH (cho1)-[r5:`dc:type`]->(c:Concept)<-[r6:`dc:type`]-(cho2)
WITH * LIMIT 8
RETURN *;


// ---------------------------------------------------------------------------
// 9. SHORTEST PATH
// How are two artists connected through the graph?
// ---------------------------------------------------------------------------
MATCH path = shortestPath(
  (a1:Agent {`foaf:name`: 'Pablo Picasso'})-[*..6]-(a2:Agent {`foaf:name`: 'Henri Matisse'})
)
RETURN path;


// ---------------------------------------------------------------------------
// 10. PLACE-CENTRIC CONSTELLATION
// A Place node with all inbound Agent and ProvidedCHO connections
// ---------------------------------------------------------------------------
MATCH (a:Agent)-[r1:`edm:hasMet`]->(p:Place {`skos:prefLabel`: 'American'})
WITH a, p, r1 LIMIT 10
MATCH (cho:ProvidedCHO)-[r2:`dc:creator`]->(a)
WITH a, p, r1, cho, r2 LIMIT 20
MATCH (cho)-[r3:`edm:currentLocation`]->(p2:Place)
RETURN *;


// ---------------------------------------------------------------------------
// 11. COLLECTION DEEP DIVE
// A specific collection (Concept via isPartOf) and its full subgraph
// ---------------------------------------------------------------------------
MATCH (cho:ProvidedCHO)-[r1:`dcterms:isPartOf`]->(c:Concept {`dc:identifier`: 'Photography'})
WITH cho, c, r1 LIMIT 10
OPTIONAL MATCH (cho)-[r2:`dc:creator`]->(a:Agent)
OPTIONAL MATCH (cho)-[r3:`dcterms:temporal`]->(t:TimeSpan)
OPTIONAL MATCH (a)-[r4:`edm:hasMet`]->(p:Place)
RETURN *;


// ---------------------------------------------------------------------------
// 12. BIPARTITE ARTIST-CONCEPT NETWORK
// Artists linked to the Concepts they work in (no artworks, cleaner graph)
// ---------------------------------------------------------------------------
MATCH (a:Agent)<-[:`dc:creator`]-(cho:ProvidedCHO)-[:`dc:type`]->(c:Concept)
WITH a, c, count(cho) AS works
WHERE works > 50
MATCH (a)-[r1:`edm:hasMet`]->(p:Place)
RETURN a, c, p, r1;


// ---------------------------------------------------------------------------
// 13. MULTI-HOP PROVENANCE CHAIN
// From artwork → creator → nationality → back to other artworks in same place
// ---------------------------------------------------------------------------
MATCH (cho:ProvidedCHO {`dc:title`: 'The Starry Night'})-[r1:`dc:creator`]->(a:Agent)-[r2:`edm:hasMet`]->(p:Place)<-[r3:`edm:hasMet`]-(peer:Agent)<-[r4:`dc:creator`]-(peerWork:ProvidedCHO)
WHERE peer <> a
WITH * LIMIT 15
RETURN *;


// ---------------------------------------------------------------------------
// 14. TEMPORAL EVOLUTION
// Three consecutive decades and their artistic output — shows graph shifting
// ---------------------------------------------------------------------------
MATCH (cho:ProvidedCHO)-[r1:`dcterms:temporal`]->(t:TimeSpan)
WHERE t.`skos:prefLabel` IN ['1950', '1960', '1970']
WITH cho, t, r1 LIMIT 15
MATCH (cho)-[r2:`dc:creator`]->(a:Agent)
OPTIONAL MATCH (cho)-[r3:`dc:type`]->(c:Concept)
RETURN *;


// ---------------------------------------------------------------------------
// 15. SCHEMA OVERVIEW
// One node of each type with all their relationships — the "brochure" query
// ---------------------------------------------------------------------------
MATCH (cho:ProvidedCHO)-[r1:`dc:creator`]->(a:Agent),
      (cho)-[r2:`dcterms:temporal`]->(t:TimeSpan),
      (cho)-[r3:`edm:currentLocation`]->(p:Place),
      (cho)-[r4:`dc:type`]->(c1:Concept),
      (cho)-[r5:`dcterms:isPartOf`]->(c2:Concept),
      (a)-[r6:`edm:hasMet`]->(p2:Place)
WHERE c1 <> c2
RETURN * LIMIT 1;
