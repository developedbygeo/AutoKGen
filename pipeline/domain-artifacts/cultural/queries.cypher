// =============================================================================
// Cultural Heritage Knowledge Graph — Evaluation Queries
// Target: EDM-compliant graph (MoMA dataset)
//
// Graph summary:
//   179,651 nodes  — ProvidedCHO (157k), Agent (14k), TimeSpan (7k), Place (852), Concept (44)
//   796,383 rels   — dc:creator, dc:type, dcterms:isPartOf, dcterms:temporal, edm:currentLocation, edm:hasMet
//
// Queries are grouped into 4 tiers of increasing complexity.
// =============================================================================


// ---------------------------------------------------------------------------
// LEVEL 1 — Basic lookups & counts
// ---------------------------------------------------------------------------

// Q1: Count nodes by label
MATCH (n)
RETURN labels(n)[0] AS label, count(n) AS total
ORDER BY total DESC;

// Q2: Count relationships by type
MATCH ()-[r]->()
RETURN type(r) AS relType, count(r) AS total
ORDER BY total DESC;

// Q3: Retrieve a single artwork by title
MATCH (cho:ProvidedCHO)
WHERE cho.`dc:title` CONTAINS 'Guernica'
RETURN cho.`dc:title` AS title, cho.`dc:date` AS date, cho.`dcterms:medium` AS medium;

// Q4: List the first 10 artists alphabetically
MATCH (a:Agent)
RETURN a.`foaf:name` AS name, a.`skos:note` AS note
ORDER BY a.`foaf:name`
LIMIT 10;

// Q5: List all distinct art categories (Concepts)
MATCH (c:Concept)
RETURN c.`dc:identifier` AS category
ORDER BY category;


// ---------------------------------------------------------------------------
// LEVEL 2 — Single-hop traversals & filtering
// ---------------------------------------------------------------------------

// Q6: Find all artworks by a specific artist
MATCH (cho:ProvidedCHO)-[:`dc:creator`]->(a:Agent)
WHERE a.`foaf:name` = 'Pablo Picasso'
RETURN cho.`dc:title` AS title, cho.`dc:date` AS date, cho.`dcterms:medium` AS medium
ORDER BY cho.`dc:date`;

// Q7: Top 15 most prolific artists (by number of works)
MATCH (cho:ProvidedCHO)-[:`dc:creator`]->(a:Agent)
RETURN a.`foaf:name` AS artist, count(cho) AS works
ORDER BY works DESC
LIMIT 15;

// Q8: Distribution of artworks across time periods
MATCH (cho:ProvidedCHO)-[:`dcterms:temporal`]->(t:TimeSpan)
RETURN t.`skos:prefLabel` AS period, count(cho) AS works
ORDER BY works DESC
LIMIT 20;

// Q9: Artworks currently located in a given nationality/place
MATCH (cho:ProvidedCHO)-[:`edm:currentLocation`]->(p:Place)
WHERE p.`skos:prefLabel` = 'American'
RETURN cho.`dc:title` AS title, cho.`dc:date` AS date
ORDER BY cho.`dc:date`
LIMIT 20;

// Q10: Artworks belonging to a specific collection (Concept)
MATCH (cho:ProvidedCHO)-[:`dcterms:isPartOf`]->(c:Concept)
WHERE c.`dc:identifier` = 'Architecture'
RETURN cho.`dc:title` AS title, cho.`dc:date` AS date
ORDER BY cho.`dc:date`
LIMIT 20;


// ---------------------------------------------------------------------------
// LEVEL 3 — Multi-hop traversals, aggregations & patterns
// ---------------------------------------------------------------------------

// Q11: Artists and the nationalities (Places) they are associated with
MATCH (a:Agent)-[:`edm:hasMet`]->(p:Place)
RETURN p.`skos:prefLabel` AS nationality, count(a) AS artists
ORDER BY artists DESC
LIMIT 15;

// Q12: For a given artist, return their works grouped by time period
MATCH (cho:ProvidedCHO)-[:`dc:creator`]->(a:Agent),
      (cho)-[:`dcterms:temporal`]->(t:TimeSpan)
WHERE a.`foaf:name` = 'Ludwig Mies van der Rohe'
RETURN t.`skos:prefLabel` AS period, collect(cho.`dc:title`)[..5] AS sampleTitles, count(cho) AS works
ORDER BY period;

// Q13: Which art categories have the widest time-span range?
MATCH (cho:ProvidedCHO)-[:`dcterms:isPartOf`]->(c:Concept),
      (cho)-[:`dcterms:temporal`]->(t:TimeSpan)
WHERE t.`edm:begin` <> 'NaN'
RETURN c.`dc:identifier` AS category,
       min(t.`edm:begin`) AS earliest,
       max(t.`edm:end`) AS latest,
       count(DISTINCT cho) AS works
ORDER BY works DESC;

// Q14: Artists who have works in multiple categories
MATCH (cho:ProvidedCHO)-[:`dc:creator`]->(a:Agent),
      (cho)-[:`dcterms:isPartOf`]->(c:Concept)
WITH a, collect(DISTINCT c.`dc:identifier`) AS categories
WHERE size(categories) > 1
RETURN a.`foaf:name` AS artist, categories, size(categories) AS categoryCount
ORDER BY categoryCount DESC
LIMIT 15;

// Q15: Medium usage distribution across time periods
MATCH (cho:ProvidedCHO)-[:`dcterms:temporal`]->(t:TimeSpan)
WHERE cho.`dcterms:medium` IS NOT NULL
RETURN t.`skos:prefLabel` AS period,
       cho.`dcterms:medium` AS medium,
       count(*) AS works
ORDER BY works DESC
LIMIT 25;


// ---------------------------------------------------------------------------
// LEVEL 4 — Graph analytics, paths & structural queries
// ---------------------------------------------------------------------------

// Q16: Find artists who share the same nationality AND time period via their works
MATCH (a1:Agent)-[:`edm:hasMet`]->(p:Place)<-[:`edm:hasMet`]-(a2:Agent)
WHERE a1 <> a2
  AND id(a1) < id(a2)
WITH a1, a2, p
MATCH (cho1:ProvidedCHO)-[:`dc:creator`]->(a1),
      (cho1)-[:`dcterms:temporal`]->(t:TimeSpan),
      (cho2:ProvidedCHO)-[:`dc:creator`]->(a2),
      (cho2)-[:`dcterms:temporal`]->(t)
RETURN a1.`foaf:name` AS artist1,
       a2.`foaf:name` AS artist2,
       p.`skos:prefLabel` AS sharedNationality,
       t.`skos:prefLabel` AS sharedPeriod,
       count(DISTINCT cho1) + count(DISTINCT cho2) AS combinedWorks
ORDER BY combinedWorks DESC
LIMIT 10;

// Q17: Shortest path between two artists through shared artworks/concepts
MATCH path = shortestPath(
  (a1:Agent {`foaf:name`: 'Pablo Picasso'})-[*..6]-(a2:Agent {`foaf:name`: 'Henri Matisse'})
)
RETURN [n IN nodes(path) |
  CASE
    WHEN n:Agent THEN n.`foaf:name`
    WHEN n:ProvidedCHO THEN n.`dc:title`
    WHEN n:Concept THEN n.`dc:identifier`
    WHEN n:Place THEN n.`skos:prefLabel`
    WHEN n:TimeSpan THEN n.`skos:prefLabel`
  END
] AS pathNodes,
length(path) AS hops;

// Q18: Detect "hub" artworks — works connected to the most distinct entity types
MATCH (cho:ProvidedCHO)
OPTIONAL MATCH (cho)-[:`dc:creator`]->(a:Agent)
OPTIONAL MATCH (cho)-[:`dcterms:temporal`]->(t:TimeSpan)
OPTIONAL MATCH (cho)-[:`edm:currentLocation`]->(p:Place)
OPTIONAL MATCH (cho)-[:`dcterms:isPartOf`]->(c:Concept)
OPTIONAL MATCH (cho)-[:`dc:type`]->(c2:Concept)
WITH cho,
     count(DISTINCT a) AS agents,
     count(DISTINCT t) AS timespans,
     count(DISTINCT p) AS places,
     count(DISTINCT c) + count(DISTINCT c2) AS concepts
WITH cho, agents + timespans + places + concepts AS connectivity
ORDER BY connectivity DESC
LIMIT 10
RETURN cho.`dc:title` AS title, cho.`dc:date` AS date, connectivity;

// Q19: Temporal evolution — how many new artists appear per decade?
MATCH (cho:ProvidedCHO)-[:`dc:creator`]->(a:Agent),
      (cho)-[:`dcterms:temporal`]->(t:TimeSpan)
WHERE t.`edm:begin` <> 'NaN'
WITH a, min(t.`edm:begin`) AS firstAppearance
WITH a, toInteger(left(firstAppearance, 3)) * 10 AS decade
WHERE decade IS NOT NULL
RETURN toString(decade) + '0s' AS decade, count(DISTINCT a) AS newArtists
ORDER BY decade;

// Q20: Full provenance chain — from artwork to all connected entities
MATCH (cho:ProvidedCHO)
WHERE cho.`dc:title` CONTAINS 'Water Lilies'
OPTIONAL MATCH (cho)-[:`dc:creator`]->(a:Agent)
OPTIONAL MATCH (cho)-[:`dcterms:temporal`]->(t:TimeSpan)
OPTIONAL MATCH (cho)-[:`edm:currentLocation`]->(p:Place)
OPTIONAL MATCH (cho)-[:`dcterms:isPartOf`]->(c:Concept)
OPTIONAL MATCH (cho)-[:`dc:type`]->(c2:Concept)
OPTIONAL MATCH (a)-[:`edm:hasMet`]->(ap:Place)
RETURN cho.`dc:title` AS title,
       cho.`dc:date` AS date,
       cho.`dcterms:medium` AS medium,
       cho.`dcterms:provenance` AS provenance,
       a.`foaf:name` AS creator,
       a.`skos:note` AS creatorNote,
       ap.`skos:prefLabel` AS creatorNationality,
       t.`skos:prefLabel` AS period,
       p.`skos:prefLabel` AS location,
       c.`dc:identifier` AS collection,
       c2.`dc:identifier` AS artType;
