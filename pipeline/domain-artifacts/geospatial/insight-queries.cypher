// ============================================================================
// GeoSPARQL Knowledge Graph — Insight Queries
// Dataset: GeoNames (7 European countries: DE, FR, IT, GB, ES, PL, NL)
// Graph:   ~790K Feature nodes, ~790K Geometry nodes
//          ~790K hasGeometry rels, ~1.58M sfWithin rels
// ============================================================================
// NOTE: Queries are optimized with LIMIT/sampling to avoid full scans on 1.58M
// nodes. Adjust limits as needed for your hardware.
// ============================================================================


// ============================================================================
// 1. GRAPH OVERVIEW
// ============================================================================

// 1a. Node counts by label (uses count store — instant)
MATCH (f:Feature) RETURN 'Feature' AS label, count(f) AS count
UNION ALL
MATCH (g:Geometry) RETURN 'Geometry' AS label, count(g) AS count;

// 1b. Relationship counts by type
MATCH ()-[r:hasGeometry]->() RETURN 'hasGeometry' AS type, count(r) AS count
UNION ALL
MATCH ()-[r:sfWithin]->() RETURN 'sfWithin' AS type, count(r) AS count;

// 1c. Property completeness — what % of Features have each property
MATCH (f:Feature)
WITH count(f) AS total
MATCH (f:Feature)
WITH total,
  count(f.label) AS hasLabel,
  count(f.type) AS hasType,
  count(f.typeLabel) AS hasTypeLabel,
  count(f.spatial) AS hasSpatial,
  count(f.spatialLabel) AS hasSpatialLabel,
  count(f.isPartOf) AS hasIsPartOf,
  count(f.isPartOfLabel) AS hasIsPartOfLabel,
  count(f.notation) AS hasNotation,
  count(f.population) AS hasPopulation,
  count(f.temporal) AS hasTemporal,
  count(f.modified) AS hasModified,
  count(f.altLabel) AS hasAltLabel,
  count(f.hiddenLabel) AS hasHiddenLabel
RETURN total,
  round(100.0 * hasLabel / total, 1) AS label_pct,
  round(100.0 * hasType / total, 1) AS type_pct,
  round(100.0 * hasSpatial / total, 1) AS spatial_pct,
  round(100.0 * hasIsPartOfLabel / total, 1) AS region_pct,
  round(100.0 * hasNotation / total, 1) AS notation_pct,
  round(100.0 * hasPopulation / total, 1) AS population_pct,
  round(100.0 * hasTemporal / total, 1) AS temporal_pct,
  round(100.0 * hasAltLabel / total, 1) AS altLabel_pct,
  round(100.0 * hasHiddenLabel / total, 1) AS hiddenLabel_pct;

// 1d. Geometry property completeness
MATCH (g:Geometry)
WITH count(g) AS total
MATCH (g:Geometry)
WITH total,
  count(g.asWKT) AS hasWKT,
  count(g.elevation) AS hasElevation,
  count(g.coordinateDimension) AS hasDim
RETURN total,
  round(100.0 * hasWKT / total, 1) AS wkt_pct,
  round(100.0 * hasElevation / total, 1) AS elevation_pct,
  round(100.0 * hasDim / total, 1) AS dimension_pct;


// ============================================================================
// 2. COUNTRY-LEVEL ANALYSIS
// ============================================================================

// 2a. Feature count per country
MATCH (f:Feature)
WHERE f.spatial IS NOT NULL AND f.spatialLabel IS NOT NULL
WITH f.spatial AS code, f.spatialLabel AS country, count(*) AS features
ORDER BY features DESC
RETURN code, country, features;

// 2b. Feature class distribution per country (GeoNames classes: P, S, T, A, H, V, L, R, U)
MATCH (f:Feature)
WHERE f.spatial IS NOT NULL AND f.notation IS NOT NULL
WITH f.spatial AS country, f.notation AS featureClass, count(*) AS cnt
ORDER BY country, cnt DESC
RETURN country, featureClass, cnt;

// 2c. Top 10 most populated cities per country
MATCH (f:Feature)
WHERE f.population > 0 AND f.spatial IS NOT NULL
  AND f.type IN ['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLC']
WITH f.spatial AS country, f.label AS city, f.population AS pop
ORDER BY country, pop DESC
WITH country, collect({city: city, population: pop})[..10] AS topCities
RETURN country, topCities;

// 2d. Average elevation per country (sampled — features with elevation > 0)
MATCH (f:Feature)-[:hasGeometry]->(g:Geometry)
WHERE g.elevation > 0 AND f.spatial IS NOT NULL
WITH f.spatial AS country, avg(g.elevation) AS avgElev, count(*) AS sampleSize
ORDER BY avgElev DESC
RETURN country, round(avgElev, 1) AS avgElevation, sampleSize;

// 2e. Feature density — how many features per region within each country
MATCH (f:Feature)
WHERE f.spatial IS NOT NULL AND f.isPartOfLabel IS NOT NULL
WITH f.spatial AS country, f.isPartOfLabel AS region, count(*) AS features
ORDER BY features DESC
WITH country, collect({region: region, features: features})[..10] AS topRegions
RETURN country, topRegions;


// ============================================================================
// 3. FEATURE TYPE DEEP-DIVE
// ============================================================================

// 3a. Top 25 most common feature types
MATCH (f:Feature)
WHERE f.type IS NOT NULL AND f.typeLabel IS NOT NULL
WITH f.type AS code, f.typeLabel AS name, count(*) AS cnt
ORDER BY cnt DESC
RETURN code, name, cnt
LIMIT 25;

// 3b. Feature class breakdown (P=populated, S=spot, T=terrain, A=admin, H=hydro, etc.)
MATCH (f:Feature)
WHERE f.notation IS NOT NULL
WITH f.notation AS cls, count(*) AS cnt
ORDER BY cnt DESC
WITH cls,
  CASE cls
    WHEN 'P' THEN 'Populated places'
    WHEN 'S' THEN 'Spots/buildings/farms'
    WHEN 'T' THEN 'Terrain (mountains, hills)'
    WHEN 'A' THEN 'Administrative divisions'
    WHEN 'H' THEN 'Hydrographic (rivers, lakes)'
    WHEN 'V' THEN 'Vegetation (forests, heaths)'
    WHEN 'L' THEN 'Parks/areas'
    WHEN 'R' THEN 'Roads/railroads'
    WHEN 'U' THEN 'Undersea'
    ELSE cls
  END AS description, cnt
RETURN cls, description, cnt;

// 3c. Cultural landmarks — castles, churches, museums, towers per country
MATCH (f:Feature)
WHERE f.type IN ['CSTL', 'CH', 'MUS', 'TOWR', 'MNMT', 'RUIN', 'LIBR', 'THTR']
WITH f.spatial AS country, f.type AS landmark, f.typeLabel AS name, count(*) AS cnt
ORDER BY country, cnt DESC
RETURN country, landmark, name, cnt;

// 3d. Infrastructure — stations, airports, ports per country
MATCH (f:Feature)
WHERE f.type IN ['RSTN', 'AIRP', 'AIRF', 'PRT', 'BUSTN', 'MTRO', 'RSTNQ']
WITH f.spatial AS country, f.type AS infra, f.typeLabel AS name, count(*) AS cnt
ORDER BY country, cnt DESC
RETURN country, infra, name, cnt;

// 3e. Natural features — mountains, peaks, passes by country
MATCH (f:Feature)
WHERE f.type IN ['MT', 'MTS', 'PK', 'PASS', 'VLC', 'GRGE', 'CLF', 'CAPE']
WITH f.spatial AS country, f.type AS feature, f.typeLabel AS name, count(*) AS cnt
ORDER BY country, cnt DESC
RETURN country, feature, name, cnt;


// ============================================================================
// 4. ELEVATION ANALYSIS
// ============================================================================

// 4a. Top 20 highest points in Europe
MATCH (f:Feature)-[:hasGeometry]->(g:Geometry)
WHERE g.elevation IS NOT NULL AND g.elevation > 0
RETURN f.label AS name, f.type AS type, f.typeLabel AS typeLabel,
       f.spatial AS country, g.elevation AS elevation, g.asWKT AS coordinates
ORDER BY g.elevation DESC
LIMIT 20;

// 4b. Highest point per country
MATCH (f:Feature)-[:hasGeometry]->(g:Geometry)
WHERE g.elevation IS NOT NULL AND g.elevation > 0 AND f.spatial IS NOT NULL
WITH f.spatial AS country, max(g.elevation) AS maxElev
MATCH (f:Feature)-[:hasGeometry]->(g:Geometry)
WHERE g.elevation = maxElev AND f.spatial = country
RETURN country, f.label AS peak, g.elevation AS elevation, g.asWKT AS coordinates
ORDER BY elevation DESC;

// 4c. Elevation distribution buckets (sampled)
MATCH (f:Feature)-[:hasGeometry]->(g:Geometry)
WHERE g.elevation IS NOT NULL AND g.elevation > 0
WITH
  CASE
    WHEN g.elevation < 100 THEN '0-100m'
    WHEN g.elevation < 500 THEN '100-500m'
    WHEN g.elevation < 1000 THEN '500-1000m'
    WHEN g.elevation < 2000 THEN '1000-2000m'
    WHEN g.elevation < 3000 THEN '2000-3000m'
    WHEN g.elevation < 4000 THEN '3000-4000m'
    ELSE '4000m+'
  END AS band, g.elevation AS elev
WITH band, count(*) AS cnt, round(avg(elev), 0) AS avgElev
ORDER BY
  CASE band
    WHEN '0-100m' THEN 1
    WHEN '100-500m' THEN 2
    WHEN '500-1000m' THEN 3
    WHEN '1000-2000m' THEN 4
    WHEN '2000-3000m' THEN 5
    WHEN '3000-4000m' THEN 6
    ELSE 7
  END
RETURN band, cnt, avgElev;

// 4d. Features below sea level
MATCH (f:Feature)-[:hasGeometry]->(g:Geometry)
WHERE g.elevation < 0
RETURN f.label AS name, f.type AS type, f.spatial AS country,
       g.elevation AS elevation, g.asWKT AS coordinates
ORDER BY g.elevation ASC
LIMIT 20;


// ============================================================================
// 5. SPATIAL HIERARCHY (sfWithin)
// ============================================================================

// 5a. sfWithin relationship targets — what do features sit within?
MATCH (f:Feature)-[:sfWithin]->(parent:Feature)
WITH parent.type AS parentType, count(*) AS cnt
ORDER BY cnt DESC
RETURN parentType, cnt;

// 5b. Countries with most admin regions (via isPartOfLabel)
MATCH (f:Feature)
WHERE f.spatial IS NOT NULL AND f.isPartOfLabel IS NOT NULL
WITH f.spatial AS country, collect(DISTINCT f.isPartOfLabel) AS regions
RETURN country, size(regions) AS distinctRegions, regions[..10] AS sampleRegions
ORDER BY distinctRegions DESC;

// 5c. Features not contained within anything (root/orphan features)
MATCH (f:Feature)
WHERE NOT (f)-[:sfWithin]->()
RETURN f.label AS name, f.type AS type, f.spatial AS country
LIMIT 25;

// 5d. Multi-level containment — features within admin divisions within countries
MATCH (f:Feature)-[:sfWithin]->(admin:Feature {type: 'administrative division'})-[:sfWithin]->(country:Feature {type: 'country'})
WITH country.label AS countryName, admin.label AS adminName, count(f) AS features
ORDER BY features DESC
RETURN countryName, adminName, features
LIMIT 20;


// ============================================================================
// 6. POPULATION ANALYSIS
// ============================================================================

// 6a. Population distribution — top 30 cities in the dataset
MATCH (f:Feature)
WHERE f.population > 0
RETURN f.label AS city, f.spatial AS country, f.isPartOfLabel AS region,
       f.type AS type, f.population AS population
ORDER BY f.population DESC
LIMIT 30;

// 6b. Total recorded population per country
MATCH (f:Feature)
WHERE f.population > 0 AND f.spatial IS NOT NULL
  AND f.type IN ['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLC', 'PPLL', 'PPLX']
WITH f.spatial AS country, sum(f.population) AS totalPop, count(*) AS places
ORDER BY totalPop DESC
RETURN country, totalPop, places;

// 6c. Population size buckets
MATCH (f:Feature)
WHERE f.population > 0
WITH
  CASE
    WHEN f.population < 1000 THEN 'village (<1K)'
    WHEN f.population < 10000 THEN 'small town (1K-10K)'
    WHEN f.population < 100000 THEN 'town (10K-100K)'
    WHEN f.population < 1000000 THEN 'city (100K-1M)'
    ELSE 'major city (1M+)'
  END AS category, f.population AS pop
WITH category, count(*) AS cnt, round(avg(pop), 0) AS avgPop
ORDER BY
  CASE category
    WHEN 'village (<1K)' THEN 1
    WHEN 'small town (1K-10K)' THEN 2
    WHEN 'town (10K-100K)' THEN 3
    WHEN 'city (100K-1M)' THEN 4
    ELSE 5
  END
RETURN category, cnt, avgPop;

// 6d. Most populated regions
MATCH (f:Feature)
WHERE f.population > 0 AND f.isPartOfLabel IS NOT NULL
WITH f.spatial AS country, f.isPartOfLabel AS region,
     sum(f.population) AS totalPop, count(*) AS places
ORDER BY totalPop DESC
RETURN country, region, totalPop, places
LIMIT 20;


// ============================================================================
// 7. TEMPORAL ANALYSIS
// ============================================================================

// 7a. Record modification timeline (by year)
MATCH (f:Feature)
WHERE f.modified IS NOT NULL
WITH substring(f.modified, 0, 4) AS year, count(*) AS updates
ORDER BY year DESC
RETURN year, updates
LIMIT 15;

// 7b. Recently modified features (2025-2026) — what's actively maintained?
MATCH (f:Feature)
WHERE f.modified >= '2025-01-01'
WITH f.spatial AS country, f.type AS ftype, count(*) AS cnt
ORDER BY cnt DESC
RETURN country, ftype, cnt
LIMIT 20;

// 7c. Timezone distribution
MATCH (f:Feature)
WHERE f.temporal IS NOT NULL
WITH f.temporal AS timezone, count(*) AS cnt
ORDER BY cnt DESC
RETURN timezone, cnt;

// 7d. Stale records — oldest modification dates
MATCH (f:Feature)
WHERE f.modified IS NOT NULL
WITH f.modified AS mod, f.label AS name, f.spatial AS country, f.type AS ftype
ORDER BY mod ASC
RETURN name, country, ftype, mod
LIMIT 15;


// ============================================================================
// 8. HYDROGRAPHIC FEATURES
// ============================================================================

// 8a. Water feature types across all countries
MATCH (f:Feature)
WHERE f.notation = 'H'
WITH f.type AS waterType, f.typeLabel AS name, count(*) AS cnt
ORDER BY cnt DESC
RETURN waterType, name, cnt
LIMIT 15;

// 8b. Water features per country
MATCH (f:Feature)
WHERE f.notation = 'H' AND f.spatial IS NOT NULL
WITH f.spatial AS country, count(*) AS waterFeatures
ORDER BY waterFeatures DESC
RETURN country, waterFeatures;

// 8c. Named lakes per country
MATCH (f:Feature)
WHERE f.type IN ['LK', 'LKS', 'LKNI', 'LKC', 'LKI', 'RSVR']
WITH f.spatial AS country, f.label AS name, f.type AS type
ORDER BY country
WITH country, collect(name)[..10] AS sampleLakes, count(*) AS total
RETURN country, total, sampleLakes
ORDER BY total DESC;

// 8d. Major rivers/streams per country
MATCH (f:Feature)
WHERE f.type IN ['STM', 'STMI', 'STMS', 'STMX', 'CNL', 'CNLI']
WITH f.spatial AS country, count(*) AS streamCount
ORDER BY streamCount DESC
RETURN country, streamCount;


// ============================================================================
// 9. GEOSPATIAL COORDINATE ANALYSIS
// ============================================================================

// 9a. Bounding box per country (min/max lat/lon from WKT points)
MATCH (f:Feature)-[:hasGeometry]->(g:Geometry)
WHERE g.asWKT IS NOT NULL AND f.spatial IS NOT NULL
WITH f.spatial AS country, g.asWKT AS wkt
WITH country,
  toFloat(split(split(wkt, '(')[1], ' ')[0]) AS lon,
  toFloat(replace(split(split(wkt, '(')[1], ' ')[1], ')', '')) AS lat
WITH country,
  round(min(lon), 3) AS minLon, round(max(lon), 3) AS maxLon,
  round(min(lat), 3) AS minLat, round(max(lat), 3) AS maxLat,
  count(*) AS points
RETURN country, minLon, maxLon, minLat, maxLat, points
ORDER BY points DESC;

// 9b. Northernmost, southernmost, easternmost, westernmost features
MATCH (f:Feature)-[:hasGeometry]->(g:Geometry)
WHERE g.asWKT IS NOT NULL AND f.type <> 'country'
WITH f, g,
  toFloat(split(split(g.asWKT, '(')[1], ' ')[0]) AS lon,
  toFloat(replace(split(split(g.asWKT, '(')[1], ' ')[1], ')', '')) AS lat
ORDER BY lat DESC LIMIT 1
RETURN 'Northernmost' AS extreme, f.label AS name, f.spatial AS country, lat, lon
UNION ALL
MATCH (f:Feature)-[:hasGeometry]->(g:Geometry)
WHERE g.asWKT IS NOT NULL AND f.type <> 'country'
WITH f, g,
  toFloat(split(split(g.asWKT, '(')[1], ' ')[0]) AS lon,
  toFloat(replace(split(split(g.asWKT, '(')[1], ' ')[1], ')', '')) AS lat
ORDER BY lat ASC LIMIT 1
RETURN 'Southernmost' AS extreme, f.label AS name, f.spatial AS country, lat, lon
UNION ALL
MATCH (f:Feature)-[:hasGeometry]->(g:Geometry)
WHERE g.asWKT IS NOT NULL AND f.type <> 'country'
WITH f, g,
  toFloat(split(split(g.asWKT, '(')[1], ' ')[0]) AS lon,
  toFloat(replace(split(split(g.asWKT, '(')[1], ' ')[1], ')', '')) AS lat
ORDER BY lon DESC LIMIT 1
RETURN 'Easternmost' AS extreme, f.label AS name, f.spatial AS country, lat, lon
UNION ALL
MATCH (f:Feature)-[:hasGeometry]->(g:Geometry)
WHERE g.asWKT IS NOT NULL AND f.type <> 'country'
WITH f, g,
  toFloat(split(split(g.asWKT, '(')[1], ' ')[0]) AS lon,
  toFloat(replace(split(split(g.asWKT, '(')[1], ' ')[1], ')', '')) AS lat
ORDER BY lon ASC LIMIT 1
RETURN 'Easternmost' AS extreme, f.label AS name, f.spatial AS country, lat, lon;

// 9c. Features at exactly sea level (elevation = 0 with geometry)
MATCH (f:Feature)-[:hasGeometry]->(g:Geometry)
WHERE g.elevation = 0 AND f.population > 1000
RETURN f.label AS name, f.spatial AS country, f.type AS type,
       f.population AS population, g.asWKT AS coordinates
ORDER BY f.population DESC
LIMIT 15;


// ============================================================================
// 10. NAMING PATTERNS
// ============================================================================

// 10a. Features with alternative names (altLabel differs from label)
MATCH (f:Feature)
WHERE f.altLabel IS NOT NULL AND f.altLabel <> f.label
RETURN f.label AS officialName, f.altLabel AS altName,
       f.spatial AS country, f.type AS type
LIMIT 20;

// 10b. Features with multiple hidden labels (comma-separated names)
MATCH (f:Feature)
WHERE f.hiddenLabel IS NOT NULL AND f.hiddenLabel CONTAINS ','
WITH f, size(split(f.hiddenLabel, ',')) AS nameCount
ORDER BY nameCount DESC
RETURN f.label AS name, f.spatial AS country, f.type AS type,
       nameCount, f.hiddenLabel AS allNames
LIMIT 15;

// 10c. Most common feature name prefixes (Saint, San, Mont, etc.)
MATCH (f:Feature)
WHERE f.label IS NOT NULL AND size(f.label) > 3
WITH split(f.label, ' ')[0] AS prefix, count(*) AS cnt
WHERE cnt > 100
ORDER BY cnt DESC
RETURN prefix, cnt
LIMIT 20;

// 10d. Name collisions — same name, different countries
MATCH (f1:Feature), (f2:Feature)
WHERE f1.label = f2.label
  AND f1.spatial < f2.spatial
  AND f1.type = f2.type
  AND f1.type IN ['PPL', 'PPLA', 'PPLA2', 'PPLA3']
WITH f1.label AS name, f1.type AS type,
     collect(DISTINCT f1.spatial) + collect(DISTINCT f2.spatial) AS countries
WHERE size(countries) >= 3
RETURN name, type, countries
LIMIT 20;


// ============================================================================
// 11. GRAPH STRUCTURE & ONTOLOGY COMPLIANCE
// ============================================================================

// 11a. Features missing geometry
MATCH (f:Feature)
WHERE NOT (f)-[:hasGeometry]->()
RETURN f.label AS name, f.type AS type, f.spatial AS country
LIMIT 20;

// 11b. Features missing sfWithin relationship
MATCH (f:Feature)
WHERE NOT (f)-[:sfWithin]->()
  AND f.type <> 'country'
RETURN f.label AS name, f.type AS type, f.spatial AS country
LIMIT 20;

// 11c. Orphan Geometry nodes (no incoming hasGeometry)
MATCH (g:Geometry)
WHERE NOT ()-[:hasGeometry]->(g)
RETURN g.id, g.asWKT
LIMIT 10;

// 11d. Relationship fan-out — features with most sfWithin connections
MATCH (parent:Feature)<-[r:sfWithin]-(child:Feature)
WITH parent.label AS name, parent.type AS type, count(r) AS children
ORDER BY children DESC
RETURN name, type, children
LIMIT 15;


// ============================================================================
// 12. VISUALIZATION SUBGRAPHS (small, display-friendly)
// ============================================================================

// 12a. A country's full hierarchy — e.g., Germany top-level admin regions
MATCH (region:Feature)-[:sfWithin]->(country:Feature {label: 'Germany', type: 'country'})
WHERE region.type = 'administrative division'
OPTIONAL MATCH (region)-[:hasGeometry]->(g:Geometry)
RETURN region.label AS region, region.isPartOfLabel AS name,
       g.asWKT AS coordinates, g.elevation AS elevation
ORDER BY region.label
LIMIT 25;

// 12b. Major cities subgraph — cities with population > 500K + their country
MATCH (f:Feature)-[:sfWithin]->(country:Feature {type: 'country'})
WHERE f.population > 500000
OPTIONAL MATCH (f)-[:hasGeometry]->(g:Geometry)
RETURN f.label AS city, country.label AS country,
       f.population AS population, g.asWKT AS coordinates
ORDER BY f.population DESC
LIMIT 30;

// 12c. Alpine peaks above 3000m — connected to their countries
MATCH (f:Feature)-[:hasGeometry]->(g:Geometry)
WHERE g.elevation > 3000 AND f.type IN ['MT', 'MTS', 'PK', 'PASS']
MATCH (f)-[:sfWithin]->(country:Feature {type: 'country'})
RETURN f.label AS peak, f.type AS type, country.label AS country,
       g.elevation AS elevation, g.asWKT AS coordinates
ORDER BY g.elevation DESC
LIMIT 30;

// 12d. Sample local neighbourhood — a city and features within
//      the same admin region (e.g., features in Bavaria)
MATCH (f:Feature)
WHERE f.isPartOfLabel = 'Bavaria' AND f.type IN ['PPL', 'PPLA', 'PPLA2', 'PPLA3']
  AND f.population > 10000
OPTIONAL MATCH (f)-[:hasGeometry]->(g:Geometry)
RETURN f.label AS place, f.type AS type, f.population AS population,
       g.asWKT AS coordinates, g.elevation AS elevation
ORDER BY f.population DESC
LIMIT 25;

// 12e. Water features of the UK — rivers, lakes, coastal features
MATCH (f:Feature)
WHERE f.spatial = 'GB' AND f.notation = 'H'
OPTIONAL MATCH (f)-[:hasGeometry]->(g:Geometry)
WITH f, g
RETURN f.label AS name, f.type AS type, f.typeLabel AS description,
       f.isPartOfLabel AS region, g.asWKT AS coordinates
LIMIT 25;
