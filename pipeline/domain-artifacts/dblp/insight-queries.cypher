// ============================================================================
// DBLP Knowledge Graph — Insight & Visualization Queries
// ============================================================================
//
// Graph overview:
//   ~16.5M nodes  |  ~41M relationships
//   13 node types |  4 relationship types (creator, partOf, publisher, hasPlaceOfPublication)
//
// All queries are bounded with LIMIT or scoped to smaller labels to stay
// performant on this large graph. Queries that scan large labels (Article,
// ProceedingsPaper, Agent) use sampling or restrict to subsets.
// ============================================================================


// ---------------------------------------------------------------------------
// 1. GRAPH OVERVIEW — high-level shape of the knowledge graph
// ---------------------------------------------------------------------------

// 1a. Node counts by label (uses APOC-free count store) [fast]
MATCH (n:Article) WITH 'Article' AS label, count(n) AS count
RETURN label, count
UNION ALL MATCH (n:Agent) WITH 'Agent' AS label, count(n) AS count RETURN label, count
UNION ALL MATCH (n:WebPage) WITH 'WebPage' AS label, count(n) AS count RETURN label, count
UNION ALL MATCH (n:ProceedingsPaper) WITH 'ProceedingsPaper' AS label, count(n) AS count RETURN label, count
UNION ALL MATCH (n:Thesis) WITH 'Thesis' AS label, count(n) AS count RETURN label, count
UNION ALL MATCH (n:Chapter) WITH 'Chapter' AS label, count(n) AS count RETURN label, count
UNION ALL MATCH (n:AcademicProceedings) WITH 'AcademicProceedings' AS label, count(n) AS count RETURN label, count
UNION ALL MATCH (n:Book) WITH 'Book' AS label, count(n) AS count RETURN label, count
UNION ALL MATCH (n:DataFile) WITH 'DataFile' AS label, count(n) AS count RETURN label, count
UNION ALL MATCH (n:ExpressionCollection) WITH 'ExpressionCollection' AS label, count(n) AS count RETURN label, count
UNION ALL MATCH (n:Place) WITH 'Place' AS label, count(n) AS count RETURN label, count
UNION ALL MATCH (n:Periodical) WITH 'Periodical' AS label, count(n) AS count RETURN label, count
UNION ALL MATCH (n:Series) WITH 'Series' AS label, count(n) AS count RETURN label, count;

// 1b. Relationship counts by type [fast — uses count store]
MATCH ()-[r:creator]->() WITH 'creator' AS type, count(r) AS count RETURN type, count
UNION ALL MATCH ()-[r:partOf]->() WITH 'partOf' AS type, count(r) AS count RETURN type, count
UNION ALL MATCH ()-[r:hasPlaceOfPublication]->() WITH 'hasPlaceOfPublication' AS type, count(r) AS count RETURN type, count
UNION ALL MATCH ()-[r:publisher]->() WITH 'publisher' AS type, count(r) AS count RETURN type, count;

// 1c. Sample avg degree — small labels only (Place, Periodical, Series, Book) [fast]
MATCH (n:Place) WITH 'Place' AS label, avg(size([(n)--() | 1])) AS avgDegree, count(n) AS cnt RETURN label, cnt, round(avgDegree, 2) AS avgDegree
UNION ALL MATCH (n:Periodical) WITH 'Periodical' AS label, avg(size([(n)--() | 1])) AS avgDegree, count(n) AS cnt RETURN label, cnt, round(avgDegree, 2) AS avgDegree
UNION ALL MATCH (n:Series) WITH 'Series' AS label, avg(size([(n)--() | 1])) AS avgDegree, count(n) AS cnt RETURN label, cnt, round(avgDegree, 2) AS avgDegree
UNION ALL MATCH (n:Book) WITH 'Book' AS label, avg(size([(n)--() | 1])) AS avgDegree, count(n) AS cnt RETURN label, cnt, round(avgDegree, 2) AS avgDegree
UNION ALL MATCH (n:Thesis) WITH 'Thesis' AS label, avg(size([(n)--() | 1])) AS avgDegree, count(n) AS cnt RETURN label, cnt, round(avgDegree, 2) AS avgDegree
UNION ALL MATCH (n:AcademicProceedings) WITH 'AcademicProceedings' AS label, avg(size([(n)--() | 1])) AS avgDegree, count(n) AS cnt RETURN label, cnt, round(avgDegree, 2) AS avgDegree;


// ---------------------------------------------------------------------------
// 2. PUBLICATION TRENDS — how output evolves over time
// ---------------------------------------------------------------------------

// 2a. Article publications per year [moderate — single label scan, grouped]
MATCH (n:Article)
WHERE n.hasPublicationYear IS NOT NULL
WITH n.hasPublicationYear AS year, count(n) AS count
RETURN year, count ORDER BY year DESC LIMIT 100;

// 2b. Proceedings papers per year [moderate]
MATCH (n:ProceedingsPaper)
WHERE n.hasPublicationYear IS NOT NULL
WITH n.hasPublicationYear AS year, count(n) AS count
RETURN year, count ORDER BY year DESC LIMIT 100;

// 2c. Books + Theses per year (smaller labels, safe) [fast]
MATCH (n)
WHERE (n:Book OR n:Thesis) AND n.hasPublicationYear IS NOT NULL
WITH n.hasPublicationYear AS year, labels(n)[0] AS type, count(n) AS count
RETURN year, type, count ORDER BY year DESC, type LIMIT 100;

// 2d. Publication growth over decades — books & theses only [fast]
MATCH (n)
WHERE (n:Book OR n:Thesis) AND n.hasPublicationYear IS NOT NULL
WITH toInteger(left(n.hasPublicationYear, 3) + "0") AS decade, labels(n)[0] AS type, count(n) AS count
RETURN decade AS decadeStart, type, count ORDER BY decade;


// ---------------------------------------------------------------------------
// 3. PROLIFIC AUTHORS — who publishes the most
// ---------------------------------------------------------------------------

// 3a. Top 50 most prolific authors [moderate — traverses creator index]
MATCH (agent:Agent)<-[:creator]-(pub)
WITH agent.name AS author, count(pub) AS totalPublications
ORDER BY totalPublications DESC LIMIT 50
RETURN author, totalPublications;

// 3b. Top 25 authors with publication type breakdown [moderate]
MATCH (agent:Agent)<-[:creator]-(pub)
WITH agent, labels(pub)[0] AS pubType, count(pub) AS count
ORDER BY count DESC
WITH agent.name AS author, collect({type: pubType, count: count}) AS breakdown,
     sum(count) AS total
ORDER BY total DESC LIMIT 25
RETURN author, total, breakdown;

// 3c. Top 30 authors by distinct venue count [moderate]
MATCH (agent:Agent)<-[:creator]-(pub)-[:partOf]->(venue)
WITH agent.name AS author, count(DISTINCT venue) AS distinctVenues, count(pub) AS pubs
ORDER BY distinctVenues DESC LIMIT 30
RETURN author, distinctVenues, pubs;


// ---------------------------------------------------------------------------
// 4. COLLABORATION NETWORKS — co-authorship patterns
// ---------------------------------------------------------------------------

// 4a. Most frequent co-author pairs [moderate — expensive but bounded by LIMIT]
MATCH (a1:Agent)<-[:creator]-(pub)-[:creator]->(a2:Agent)
WHERE id(a1) < id(a2)
WITH a1.name AS author1, a2.name AS author2, count(pub) AS sharedPublications
ORDER BY sharedPublications DESC LIMIT 50
RETURN author1, author2, sharedPublications;

// 4b. Avg co-authors per pub type — sampled from small labels [fast]
MATCH (pub:Book)-[:creator]->(a:Agent)
WITH pub, 'Book' AS pubType, count(a) AS authorCount
WITH pubType, round(avg(authorCount), 2) AS avgAuthors, max(authorCount) AS maxAuthors, count(*) AS totalPubs
RETURN pubType, avgAuthors, maxAuthors, totalPubs
UNION ALL
MATCH (pub:Thesis)-[:creator]->(a:Agent)
WITH pub, 'Thesis' AS pubType, count(a) AS authorCount
WITH pubType, round(avg(authorCount), 2) AS avgAuthors, max(authorCount) AS maxAuthors, count(*) AS totalPubs
RETURN pubType, avgAuthors, maxAuthors, totalPubs
UNION ALL
MATCH (pub:Chapter)-[:creator]->(a:Agent)
WITH pub, 'Chapter' AS pubType, count(a) AS authorCount
WITH pubType, round(avg(authorCount), 2) AS avgAuthors, max(authorCount) AS maxAuthors, count(*) AS totalPubs
RETURN pubType, avgAuthors, maxAuthors, totalPubs;

// 4c. Publications with the most co-authors [moderate]
MATCH (pub)-[:creator]->(agent:Agent)
WITH pub, count(agent) AS authorCount
ORDER BY authorCount DESC LIMIT 20
RETURN pub.title AS title, labels(pub)[0] AS type, authorCount, pub.hasPublicationYear AS year;


// ---------------------------------------------------------------------------
// 5. VENUES — journals, proceedings, and series analysis
// ---------------------------------------------------------------------------

// 5a. Largest periodicals by article count [moderate — bounded by Periodical count ~2K]
MATCH (article:Article)-[:partOf]->(journal:Periodical)
WITH journal.title AS journal, count(article) AS articleCount
ORDER BY articleCount DESC LIMIT 30
RETURN journal, articleCount;

// 5b. Largest conference proceedings by paper count [moderate — bounded by AcademicProceedings ~63K]
MATCH (paper:ProceedingsPaper)-[:partOf]->(proc:AcademicProceedings)
WITH proc.title AS proceedings, count(paper) AS paperCount
ORDER BY paperCount DESC LIMIT 30
RETURN proceedings, paperCount;

// 5c. Most active book series [fast — Series only ~1.6K]
MATCH (b)-[:partOf]->(s:Series)
WITH s.title AS series, count(b) AS entryCount, collect(DISTINCT labels(b)[0]) AS types
ORDER BY entryCount DESC LIMIT 20
RETURN series, entryCount, types;

// 5d. Longest-running venues (Periodical + Series only — ~3.7K nodes) [fast]
MATCH (pub)-[:partOf]->(venue)
WHERE pub.hasPublicationYear IS NOT NULL AND (venue:Periodical OR venue:Series)
WITH venue.title AS venue, labels(venue)[0] AS venueType,
     min(toInteger(pub.hasPublicationYear)) AS firstYear,
     max(toInteger(pub.hasPublicationYear)) AS lastYear,
     count(pub) AS totalPubs
WHERE firstYear > 1900
RETURN venue, venueType, firstYear, lastYear, lastYear - firstYear AS spanYears, totalPubs
ORDER BY spanYears DESC LIMIT 25;


// ---------------------------------------------------------------------------
// 6. PUBLISHERS & GEOGRAPHY
// ---------------------------------------------------------------------------

// 6a. Top publishers by publication count [fast — publisher rels only ~109K]
MATCH (pub)-[:publisher]->(agent:Agent)
WITH agent.name AS publisher, count(pub) AS publicationCount
ORDER BY publicationCount DESC LIMIT 25
RETURN publisher, publicationCount;

// 6b. Publication places ranked [fast — hasPlaceOfPublication rels only ~153K]
MATCH (pub)-[:hasPlaceOfPublication]->(place:Place)
WITH place.name AS city, count(pub) AS publicationCount
ORDER BY publicationCount DESC LIMIT 30
RETURN city, publicationCount;

// 6c. Publisher-place combinations [fast — intersection of small rel sets]
MATCH (pub)-[:publisher]->(agent:Agent),
      (pub)-[:hasPlaceOfPublication]->(place:Place)
WITH agent.name AS publisher, place.name AS city, count(pub) AS count
ORDER BY count DESC LIMIT 25
RETURN publisher, city, count;


// ---------------------------------------------------------------------------
// 7. CONTENT & THEMATIC ANALYSIS
// ---------------------------------------------------------------------------

// 7a. Title keywords — SAMPLED from recent proceedings papers only [moderate]
MATCH (n:ProceedingsPaper)
WHERE n.title IS NOT NULL AND n.hasPublicationYear IS NOT NULL
  AND toInteger(n.hasPublicationYear) >= 2020
WITH n.title AS title LIMIT 100000
WITH split(toLower(title), ' ') AS words
UNWIND words AS word
WITH trim(word) AS w
WHERE size(w) > 4
  AND NOT w IN ['using', 'based', 'about', 'their', 'which', 'these',
                 'through', 'between', 'approach', 'towards', 'under',
                 'study', 'paper', 'model', 'method', 'system', 'novel',
                 'learning', 'analysis', 'efficient', 'network', 'data']
WITH w, count(*) AS freq
ORDER BY freq DESC LIMIT 40
RETURN w AS keyword, freq;

// 7b. AI/ML publication trend — scoped to ProceedingsPaper only [moderate]
MATCH (n:ProceedingsPaper)
WHERE n.title IS NOT NULL AND n.hasPublicationYear IS NOT NULL
  AND toInteger(n.hasPublicationYear) >= 2010
  AND (toLower(n.title) CONTAINS 'machine learning'
       OR toLower(n.title) CONTAINS 'deep learning'
       OR toLower(n.title) CONTAINS 'artificial intelligence'
       OR toLower(n.title) CONTAINS 'neural network')
WITH n.hasPublicationYear AS year,
     CASE
       WHEN toLower(n.title) CONTAINS 'deep learning' THEN 'Deep Learning'
       WHEN toLower(n.title) CONTAINS 'machine learning' THEN 'Machine Learning'
       WHEN toLower(n.title) CONTAINS 'neural network' THEN 'Neural Networks'
       ELSE 'Artificial Intelligence'
     END AS topic,
     count(n) AS count
RETURN year, topic, count ORDER BY year, topic;

// 7c. Trending CS topics in proceedings (2018+) — sampled [moderate]
MATCH (n:ProceedingsPaper)
WHERE n.title IS NOT NULL AND n.hasPublicationYear IS NOT NULL
  AND toInteger(n.hasPublicationYear) >= 2018
WITH n.title AS title, n.hasPublicationYear AS year LIMIT 200000
WITH split(toLower(title), ' ') AS words, year
UNWIND words AS word
WITH trim(word) AS w, year
WHERE w IN ['transformer', 'attention', 'federated', 'adversarial', 'generative',
            'reinforcement', 'autonomous', 'blockchain', 'quantum', 'fairness',
            'explainable', 'contrastive', 'diffusion', 'foundation', 'multimodal',
            'privacy', 'robustness', 'sustainability']
WITH w AS topic, year, count(*) AS count
RETURN topic, year, count ORDER BY topic, year;


// ---------------------------------------------------------------------------
// 8. GRAPH STRUCTURE & CONNECTIVITY
// ---------------------------------------------------------------------------

// 8a. Orphan nodes — scoped per small label [fast]
MATCH (n:Book) WHERE NOT (n)--() WITH 'Book' AS label, count(n) AS orphanCount WHERE orphanCount > 0 RETURN label, orphanCount
UNION ALL MATCH (n:Thesis) WHERE NOT (n)--() WITH 'Thesis' AS label, count(n) AS orphanCount WHERE orphanCount > 0 RETURN label, orphanCount
UNION ALL MATCH (n:Chapter) WHERE NOT (n)--() WITH 'Chapter' AS label, count(n) AS orphanCount WHERE orphanCount > 0 RETURN label, orphanCount
UNION ALL MATCH (n:DataFile) WHERE NOT (n)--() WITH 'DataFile' AS label, count(n) AS orphanCount WHERE orphanCount > 0 RETURN label, orphanCount
UNION ALL MATCH (n:Place) WHERE NOT (n)--() WITH 'Place' AS label, count(n) AS orphanCount WHERE orphanCount > 0 RETURN label, orphanCount
UNION ALL MATCH (n:Series) WHERE NOT (n)--() WITH 'Series' AS label, count(n) AS orphanCount WHERE orphanCount > 0 RETURN label, orphanCount
UNION ALL MATCH (n:Periodical) WHERE NOT (n)--() WITH 'Periodical' AS label, count(n) AS orphanCount WHERE orphanCount > 0 RETURN label, orphanCount
UNION ALL MATCH (n:AcademicProceedings) WHERE NOT (n)--() WITH 'AcademicProceedings' AS label, count(n) AS orphanCount WHERE orphanCount > 0 RETURN label, orphanCount
UNION ALL MATCH (n:ExpressionCollection) WHERE NOT (n)--() WITH 'ExpressionCollection' AS label, count(n) AS orphanCount WHERE orphanCount > 0 RETURN label, orphanCount;

// 8b. Hub nodes — highest-degree venues/publishers (small labels) [fast]
MATCH (n:Periodical)
WITH n, size([(n)<-[:partOf]-() | 1]) AS degree
ORDER BY degree DESC LIMIT 10
RETURN 'Periodical' AS label, n.title AS name, degree
UNION ALL
MATCH (n:AcademicProceedings)
WITH n, size([(n)<-[:partOf]-() | 1]) AS degree
ORDER BY degree DESC LIMIT 10
RETURN 'AcademicProceedings' AS label, n.title AS name, degree
UNION ALL
MATCH (n:Series)
WITH n, size([(n)<-[:partOf]-() | 1]) AS degree
ORDER BY degree DESC LIMIT 10
RETURN 'Series' AS label, n.title AS name, degree;


// ---------------------------------------------------------------------------
// 9. THESIS ANALYSIS
// ---------------------------------------------------------------------------

// 9a. Thesis output by year [fast — Thesis ~150K]
MATCH (t:Thesis)
WHERE t.hasPublicationYear IS NOT NULL
WITH t.hasPublicationYear AS year, count(t) AS theses
ORDER BY year DESC LIMIT 50
RETURN year, theses;

// 9b. Most active thesis institutions (via publisher) [fast]
MATCH (t:Thesis)-[:publisher]->(inst:Agent)
WITH inst.name AS institution, count(t) AS thesisCount
ORDER BY thesisCount DESC LIMIT 25
RETURN institution, thesisCount;

// 9c. Thesis publication places [fast]
MATCH (t:Thesis)-[:hasPlaceOfPublication]->(place:Place)
WITH place.name AS city, count(t) AS thesisCount
ORDER BY thesisCount DESC LIMIT 20
RETURN city, thesisCount;


// ---------------------------------------------------------------------------
// 10. SAMPLE SUBGRAPH QUERIES — for Neo4j Browser visualization
// ---------------------------------------------------------------------------

// 10a. Visualize a prolific author's publication network
MATCH (agent:Agent)<-[:creator]-(pub)
WITH agent, count(pub) AS pubs
ORDER BY pubs DESC LIMIT 1
MATCH (agent)<-[:creator]-(pub)
WITH agent, pub LIMIT 20
OPTIONAL MATCH (pub)-[:partOf]->(venue)
OPTIONAL MATCH (pub)-[:creator]->(coauthor:Agent)
WHERE coauthor <> agent
WITH agent, pub, venue, collect(coauthor)[..3] AS coauthors
UNWIND coauthors AS coauthor
RETURN agent, pub, venue, coauthor;

// 10b. Visualize a top journal's article network
MATCH (journal:Periodical)<-[:partOf]-(article:Article)
WITH journal, count(article) AS cnt
ORDER BY cnt DESC LIMIT 1
MATCH (article:Article)-[:partOf]->(journal)
WITH journal, article LIMIT 15
OPTIONAL MATCH (article)-[:creator]->(author:Agent)
WITH journal, article, collect(author)[..3] AS authors
UNWIND authors AS author
RETURN journal, article, author;

// 10c. Visualize a multi-author paper's co-authorship cluster
MATCH (p:ProceedingsPaper)-[:creator]->(a:Agent)
WITH p, collect(a) AS authors
WHERE size(authors) >= 5
WITH p, authors LIMIT 1
UNWIND authors AS author
OPTIONAL MATCH (author)<-[:creator]-(otherPub)
WHERE otherPub <> p
WITH p, author, otherPub LIMIT 40
RETURN p, author, otherPub;
