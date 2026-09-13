# Notice

**Agentic KG Artifact (AutoKGEN)**

Copyright (c) 2026 `developedbygeo`

## Licensing summary

| What                                                                                                                                                                                     | License                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Source code — `pipeline/`, `mcp/`, `chatbot/`, excluding the third-party material below                                                                                                  | [MIT](LICENSE)                                                                                  |
| Documentation, the SHACL shapes authored for this work (`pipeline/domain-data/*/validation/*.ttl`), and the generated graph artifacts and reports under `pipeline/domain-data/*/output/` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)                                       |
| Accompanying paper                                                                                                                                                                       | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), per the CEUR-WS.org author agreement |

## Third-party material redistributed in this repository

### Europeana Data Model (EDM) v5.2.4

- **Files:** `pipeline/domain-data/cultural-moma/ontology/edm.owl`, `pipeline/domain-data/cultural-moma/ontology/ontology.owl`
- **Publisher:** Europeana Foundation
- **Creator:** Antoine Isaac, et al.
- **License:** none declared upstream
- **Source:** [EDM documentation](https://pro.europeana.eu/page/edm-documentation) · [edm.owl](https://www.europeana.eu/schemas/edm/rdf/edm.owl)

Redistributed unmodified, for reproducibility, with attribution to the Europeana Foundation. The EDM schema file carries no explicit license statement upstream.

### FaBiO — FRBR-aligned Bibliographic Ontology v2.2

- **File:** `pipeline/domain-data/scientific-dblp/ontology/fabio.xml`
- **Creators:** Silvio Peroni, David Shotton
- **License:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode)
- **Source:** [sparontologies.net/ontologies/fabio](http://www.sparontologies.net/ontologies/fabio)

Redistributed unmodified.

### GeoSPARQL Ontology v1.1

- **File:** `pipeline/domain-data/geospatial/ontology/geo.ttl`
- **Copyright:** © 2021 Open Geospatial Consortium
- **License:** [OGC Document License](https://www.ogc.org/license)
- **Source:** [opengis.net/ont/geosparql](http://www.opengis.net/ont/geosparql)

Redistributed unmodified.

## Third-party datasets (not redistributed)

The raw input datasets are not included in this repository — [pipeline/README.md](pipeline/README.md#datasets) documents where to download each one.

| Dataset                                                                                            | Terms                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MoMA Collection](https://github.com/MuseumofModernArt/collection) — `artists.csv`, `artworks.csv` | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) Public Domain Dedication. MoMA requests citation of DOI [10.5281/zenodo.22656000](https://doi.org/10.5281/zenodo.22656000). |
| [GeoNames](https://www.geonames.org/about.html) — country files and supplementary reference tables | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)                                                                                                                                 |
| [DBLP](https://dblp.org/xml/) — `dblp.xml`, `dblp.dtd`                                             | Consult dblp.org for current terms of use.                                                                                                                                                |
