// =============================================================================
// Cultural Heritage Knowledge Graph — Advanced Relationship Queries
// Target: EDM-compliant graph (MoMA dataset, ~180k nodes, ~796k relationships)
//
// Relationship types:
//   dc:creator         (ProvidedCHO → Agent)     156k
//   dc:type            (ProvidedCHO → Concept)   157k
//   dcterms:isPartOf   (ProvidedCHO → Concept)   157k
//   dcterms:temporal   (ProvidedCHO → TimeSpan)  155k
//   edm:currentLocation(ProvidedCHO → Place)     156k
//   edm:hasMet         (Agent → Place)            14k
// =============================================================================


// ---------------------------------------------------------------------------
// A. CO-OCCURRENCE & IMPLICIT RELATIONSHIP DISCOVERY
// ---------------------------------------------------------------------------

// A1: Artist collaboration network — artists who share the SAME artwork
//     (co-creators on a single ProvidedCHO)
MATCH (a1:Agent)<-[:`dc:creator`]-(cho:ProvidedCHO)-[:`dc:creator`]->(a2:Agent)
WHERE id(a1) < id(a2)
RETURN a1.`foaf:name` AS artist1,
       a2.`foaf:name` AS artist2,
       count(cho) AS sharedWorks,
       collect(cho.`dc:title`)[..5] AS sampleTitles
ORDER BY sharedWorks DESC
LIMIT 20;

// A2: Concept co-occurrence — which art types and collections appear together?
//     (artworks that link to both a dc:type Concept AND a dcterms:isPartOf Concept)
MATCH (cho:ProvidedCHO)-[:`dc:type`]->(artType:Concept),
      (cho)-[:`dcterms:isPartOf`]->(collection:Concept)
WHERE artType <> collection
RETURN artType.`dc:identifier` AS artType,
       collection.`dc:identifier` AS collection,
       count(cho) AS overlap
ORDER BY overlap DESC
LIMIT 25;

// A3: Place-to-Place implicit connections through shared artists
//     Two nationalities are "linked" when artists from both contributed works
//     in the same time period
MATCH (p1:Place)<-[:`edm:hasMet`]-(a1:Agent)<-[:`dc:creator`]-(cho1:ProvidedCHO)-[:`dcterms:temporal`]->(t:TimeSpan),
      (p2:Place)<-[:`edm:hasMet`]-(a2:Agent)<-[:`dc:creator`]-(cho2:ProvidedCHO)-[:`dcterms:temporal`]->(t)
WHERE id(p1) < id(p2)
  AND a1 <> a2
RETURN p1.`skos:prefLabel` AS place1,
       p2.`skos:prefLabel` AS place2,
       count(DISTINCT t) AS sharedPeriods,
       count(DISTINCT a1) + count(DISTINCT a2) AS totalArtists,
       collect(DISTINCT t.`skos:prefLabel`)[..5] AS samplePeriods
ORDER BY sharedPeriods DESC
LIMIT 15;


// ---------------------------------------------------------------------------
// B. MULTI-HOP PATH ANALYSIS
// ---------------------------------------------------------------------------

// B1: Full relationship chain — Artwork → Creator → Nationality → Other artists
//     from same nationality → Their artworks → Those artworks' time periods
//     "Given an artwork, what artistic ecosystem does it belong to?"
MATCH (cho:ProvidedCHO {`dc:title`: 'The Starry Night'})-[:`dc:creator`]->(artist:Agent)
MATCH (artist)-[:`edm:hasMet`]->(place:Place)
MATCH (peer:Agent)-[:`edm:hasMet`]->(place)
WHERE peer <> artist
MATCH (peerWork:ProvidedCHO)-[:`dc:creator`]->(peer)
MATCH (peerWork)-[:`dcterms:temporal`]->(t:TimeSpan)
RETURN artist.`foaf:name` AS originalArtist,
       place.`skos:prefLabel` AS sharedNationality,
       peer.`foaf:name` AS peerArtist,
       count(DISTINCT peerWork) AS peerWorks,
       collect(DISTINCT t.`skos:prefLabel`)[..5] AS activePeriods
ORDER BY peerWorks DESC
LIMIT 15;

// B2: Variable-length path — find ALL paths up to 4 hops between
//     two specific artists through any node type
MATCH path = (a1:Agent {`foaf:name`: 'Pablo Picasso'})-[*1..4]-(a2:Agent {`foaf:name`: 'Henri Matisse'})
WITH path, length(path) AS hops,
     [n IN nodes(path) | CASE
       WHEN n:Agent THEN 'Agent: ' + n.`foaf:name`
       WHEN n:ProvidedCHO THEN 'CHO: ' + n.`dc:title`
       WHEN n:Concept THEN 'Concept: ' + n.`dc:identifier`
       WHEN n:Place THEN 'Place: ' + n.`skos:prefLabel`
       WHEN n:TimeSpan THEN 'Time: ' + n.`skos:prefLabel`
     END] AS pathDescription,
     [r IN relationships(path) | type(r)] AS relTypes
RETURN pathDescription, relTypes, hops
ORDER BY hops
LIMIT 10;

// B3: Concept hierarchy traversal — artworks reachable through chains of
//     Concept relationships (dc:type → isPartOf chains)
MATCH (cho:ProvidedCHO)-[:`dc:type`]->(artType:Concept)<-[:`dcterms:isPartOf`]-(relatedCHO:ProvidedCHO)
WHERE cho <> relatedCHO
WITH cho, artType, collect(DISTINCT relatedCHO.`dc:title`)[..3] AS relatedTitles,
     count(DISTINCT relatedCHO) AS relatedCount
ORDER BY relatedCount DESC
LIMIT 10
RETURN cho.`dc:title` AS artwork,
       artType.`dc:identifier` AS sharedConcept,
       relatedCount,
       relatedTitles;


// ---------------------------------------------------------------------------
// C. TEMPORAL RELATIONSHIP PATTERNS
// ---------------------------------------------------------------------------

// C1: Artistic influence chains — ordered by time, find artist → successor
//     patterns within the same nationality
MATCH (early:Agent)-[:`edm:hasMet`]->(place:Place)<-[:`edm:hasMet`]-(later:Agent)
WHERE early <> later
MATCH (earlyWork:ProvidedCHO)-[:`dc:creator`]->(early),
      (earlyWork)-[:`dcterms:temporal`]->(t1:TimeSpan)
MATCH (laterWork:ProvidedCHO)-[:`dc:creator`]->(later),
      (laterWork)-[:`dcterms:temporal`]->(t2:TimeSpan)
WHERE t1.`skos:prefLabel` < t2.`skos:prefLabel`
WITH place, early, later,
     min(t1.`skos:prefLabel`) AS earlyStart,
     min(t2.`skos:prefLabel`) AS laterStart,
     count(DISTINCT earlyWork) AS earlyWorks,
     count(DISTINCT laterWork) AS laterWorks
WHERE earlyStart < laterStart
RETURN place.`skos:prefLabel` AS nationality,
       early.`foaf:name` AS predecessor,
       earlyStart AS activeFrom,
       earlyWorks,
       later.`foaf:name` AS successor,
       laterStart AS activeFrom2,
       laterWorks
ORDER BY nationality, earlyStart
LIMIT 20;

// C2: Temporal density — which decades have the most cross-entity activity?
//     (unique artists, places, concepts all active in that period)
MATCH (cho:ProvidedCHO)-[:`dcterms:temporal`]->(t:TimeSpan)
WITH t, count(DISTINCT cho) AS works
OPTIONAL MATCH (cho2:ProvidedCHO)-[:`dcterms:temporal`]->(t)
OPTIONAL MATCH (cho2)-[:`dc:creator`]->(a:Agent)
OPTIONAL MATCH (cho2)-[:`edm:currentLocation`]->(p:Place)
OPTIONAL MATCH (cho2)-[:`dc:type`]->(c:Concept)
RETURN t.`skos:prefLabel` AS period,
       works,
       count(DISTINCT a) AS uniqueArtists,
       count(DISTINCT p) AS uniqueLocations,
       count(DISTINCT c) AS uniqueArtTypes
ORDER BY works DESC
LIMIT 20;

// C3: Temporal spread of an artist — how many distinct decades does their work span?
MATCH (a:Agent)<-[:`dc:creator`]-(cho:ProvidedCHO)-[:`dcterms:temporal`]->(t:TimeSpan)
WITH a, collect(DISTINCT t.`skos:prefLabel`) AS periods
WHERE size(periods) > 3
RETURN a.`foaf:name` AS artist,
       a.`skos:note` AS bio,
       size(periods) AS distinctPeriods,
       periods[..10] AS samplePeriods,
       periods[0] AS earliest,
       periods[size(periods)-1] AS latest
ORDER BY distinctPeriods DESC
LIMIT 15;


// ---------------------------------------------------------------------------
// D. GRAPH STRUCTURE & CENTRALITY
// ---------------------------------------------------------------------------

// D1: Relationship fanout — nodes with the highest total degree
//     (most connected entities regardless of type)
MATCH (n)
WITH n, labels(n)[0] AS nodeType, size([(n)-[]-() | 1]) AS degree
ORDER BY degree DESC
LIMIT 20
RETURN nodeType,
       CASE nodeType
         WHEN 'Agent' THEN n.`foaf:name`
         WHEN 'ProvidedCHO' THEN n.`dc:title`
         WHEN 'Concept' THEN n.`dc:identifier`
         WHEN 'Place' THEN n.`skos:prefLabel`
         WHEN 'TimeSpan' THEN n.`skos:prefLabel`
       END AS name,
       degree;

// D2: Bipartite relationship density — for each Place, how many distinct
//     relationship "types" flow through it? (Place as a bridge node)
MATCH (p:Place)
OPTIONAL MATCH (p)<-[:`edm:hasMet`]-(a:Agent)
OPTIONAL MATCH (p)<-[:`edm:currentLocation`]-(cho:ProvidedCHO)
WITH p,
     count(DISTINCT a) AS incomingAgents,
     count(DISTINCT cho) AS incomingCHOs,
     count(DISTINCT a) + count(DISTINCT cho) AS totalConnections
ORDER BY totalConnections DESC
RETURN p.`skos:prefLabel` AS place,
       incomingAgents AS artists,
       incomingCHOs AS artworks,
       totalConnections,
       CASE WHEN incomingAgents > 0 AND incomingCHOs > 0
            THEN 'Bridge' ELSE 'Leaf' END AS role
LIMIT 20;

// D3: Concept centrality — which Concepts bridge the most distinct artists?
//     (Concepts that connect diverse creator pools)
MATCH (a:Agent)<-[:`dc:creator`]-(cho:ProvidedCHO)-[:`dc:type`]->(c:Concept)
WITH c, collect(DISTINCT a) AS artists
RETURN c.`dc:identifier` AS concept,
       size(artists) AS uniqueArtists,
       [a IN artists[..5] | a.`foaf:name`] AS sampleArtists
ORDER BY uniqueArtists DESC;


// ---------------------------------------------------------------------------
// E. SUBGRAPH EXTRACTION & PATTERN MATCHING
// ---------------------------------------------------------------------------

// E1: Extract the full "artistic ecosystem" subgraph for a nationality —
//     all agents, their works, the works' concepts, and time periods
MATCH (a:Agent)-[r1:`edm:hasMet`]->(p:Place {`skos:prefLabel`: 'French'})
MATCH (cho:ProvidedCHO)-[r2:`dc:creator`]->(a)
OPTIONAL MATCH (cho)-[r3:`dcterms:temporal`]->(t:TimeSpan)
OPTIONAL MATCH (cho)-[r4:`dc:type`]->(c:Concept)
RETURN a, cho, p, t, c, r1, r2, r3, r4
LIMIT 50;

// E2: Find "star patterns" — artworks that connect to ALL five entity types
//     simultaneously (Agent + Place + TimeSpan + type Concept + collection Concept)
MATCH (cho:ProvidedCHO)-[r1:`dc:creator`]->(a:Agent),
      (cho)-[r2:`edm:currentLocation`]->(p:Place),
      (cho)-[r3:`dcterms:temporal`]->(t:TimeSpan),
      (cho)-[r4:`dc:type`]->(artType:Concept),
      (cho)-[r5:`dcterms:isPartOf`]->(collection:Concept)
WHERE artType <> collection
RETURN cho.`dc:title` AS title,
       a.`foaf:name` AS creator,
       p.`skos:prefLabel` AS location,
       t.`skos:prefLabel` AS period,
       artType.`dc:identifier` AS artType,
       collection.`dc:identifier` AS collection
LIMIT 15;

// E3: Diamond pattern — two artists from the same place who both created
//     artworks of the same type in the same time period
MATCH (a1:Agent)-[:`edm:hasMet`]->(p:Place)<-[:`edm:hasMet`]-(a2:Agent)
WHERE id(a1) < id(a2)
MATCH (cho1:ProvidedCHO)-[:`dc:creator`]->(a1),
      (cho1)-[:`dc:type`]->(artType:Concept),
      (cho1)-[:`dcterms:temporal`]->(t:TimeSpan)
MATCH (cho2:ProvidedCHO)-[:`dc:creator`]->(a2),
      (cho2)-[:`dc:type`]->(artType),
      (cho2)-[:`dcterms:temporal`]->(t)
RETURN a1.`foaf:name` AS artist1,
       a2.`foaf:name` AS artist2,
       p.`skos:prefLabel` AS sharedNationality,
       artType.`dc:identifier` AS sharedArtType,
       t.`skos:prefLabel` AS sharedPeriod,
       count(DISTINCT cho1) AS artist1Works,
       count(DISTINCT cho2) AS artist2Works
ORDER BY artist1Works + artist2Works DESC
LIMIT 15;


// ---------------------------------------------------------------------------
// F. AGGREGATION PIPELINES & ANALYTICS
// ---------------------------------------------------------------------------

// F1: Artist diversity index — for each artist, how many distinct Places,
//     Concepts, and TimePeriods are they connected to through their works?
MATCH (a:Agent)<-[:`dc:creator`]-(cho:ProvidedCHO)
OPTIONAL MATCH (cho)-[:`dcterms:temporal`]->(t:TimeSpan)
OPTIONAL MATCH (cho)-[:`edm:currentLocation`]->(p:Place)
OPTIONAL MATCH (cho)-[:`dc:type`]->(c:Concept)
OPTIONAL MATCH (cho)-[:`dcterms:isPartOf`]->(col:Concept)
WITH a,
     count(DISTINCT cho) AS totalWorks,
     count(DISTINCT t) AS timePeriods,
     count(DISTINCT p) AS locations,
     count(DISTINCT c) AS artTypes,
     count(DISTINCT col) AS collections
WITH a, totalWorks, timePeriods, locations, artTypes, collections,
     timePeriods + locations + artTypes + collections AS diversityScore
ORDER BY diversityScore DESC
LIMIT 20
RETURN a.`foaf:name` AS artist,
       a.`skos:note` AS bio,
       totalWorks,
       timePeriods,
       locations,
       artTypes,
       collections,
       diversityScore;

// F2: Medium evolution — how does the dominant medium change across decades?
MATCH (cho:ProvidedCHO)-[:`dcterms:temporal`]->(t:TimeSpan)
WHERE cho.`dcterms:medium` IS NOT NULL
WITH t.`skos:prefLabel` AS period, cho.`dcterms:medium` AS medium, count(*) AS cnt
ORDER BY period, cnt DESC
WITH period, collect({medium: medium, count: cnt})[0] AS dominant, sum(cnt) AS totalWorks
RETURN period,
       dominant.medium AS dominantMedium,
       dominant.count AS dominantCount,
       totalWorks,
       round(100.0 * dominant.count / totalWorks, 1) AS dominantPct
ORDER BY period;

// F3: Nationality influence over time — for each decade, which nationality
//     contributes the most artworks? Track the shifting dominance.
MATCH (cho:ProvidedCHO)-[:`dc:creator`]->(a:Agent)-[:`edm:hasMet`]->(p:Place),
      (cho)-[:`dcterms:temporal`]->(t:TimeSpan)
WITH t.`skos:prefLabel` AS period,
     p.`skos:prefLabel` AS nationality,
     count(DISTINCT cho) AS works
ORDER BY period, works DESC
WITH period, collect({nationality: nationality, works: works}) AS rankings
RETURN period,
       rankings[0].nationality AS dominant,
       rankings[0].works AS dominantWorks,
       CASE WHEN size(rankings) > 1 THEN rankings[1].nationality ELSE null END AS runner_up,
       CASE WHEN size(rankings) > 1 THEN rankings[1].works ELSE null END AS runner_upWorks,
       size(rankings) AS totalNationalities
ORDER BY period;

// F4: Relationship type distribution per artist — what percentage of an
//     artist's works have temporal, location, and type metadata?
MATCH (a:Agent)<-[:`dc:creator`]-(cho:ProvidedCHO)
WITH a, count(cho) AS totalWorks, collect(cho) AS works
WHERE totalWorks > 50
UNWIND works AS cho
OPTIONAL MATCH (cho)-[:`dcterms:temporal`]->(t:TimeSpan)
OPTIONAL MATCH (cho)-[:`edm:currentLocation`]->(p:Place)
OPTIONAL MATCH (cho)-[:`dc:type`]->(c:Concept)
WITH a, totalWorks,
     count(DISTINCT t) AS withTemporal,
     count(DISTINCT p) AS withLocation,
     count(DISTINCT c) AS withType
RETURN a.`foaf:name` AS artist,
       totalWorks,
       round(100.0 * withTemporal / totalWorks, 1) AS temporalCoverage,
       round(100.0 * withLocation / totalWorks, 1) AS locationCoverage,
       round(100.0 * withType / totalWorks, 1) AS typeCoverage
ORDER BY totalWorks DESC
LIMIT 20;
