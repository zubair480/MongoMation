// Atlas Search (lexical) index definitions for engineering memory, used next to the autoEmbed vector
// indexes (`lessons_vec`, `diagnoses_vec`, created by scripts/setup-atlas.ts). Applied by scripts/setup-search.ts.
//
//   diagnoses_search  full-text (english) on the diagnosis text/summary/causes, autocomplete on summary,
//                     token fields for exact filters and $searchMeta string facets (scene, fault, split).
//   lessons_search    full-text on pattern/fix/text, autocomplete on pattern, boolean filters.
//
// Free (M0) clusters cap search + vector indexes at 3 IN TOTAL per cluster; setup-search creates them in
// priority order (diagnoses first: that collection has the data and backs the dashboard facets) and reports
// any it could not create. Retrieval treats a missing lexical index as "vector only".

export const SEARCH_INDEX = { diagnoses: "diagnoses_search", lessons: "lessons_search" } as const;
export const VECTOR_INDEX = { diagnoses: "diagnoses_vec", lessons: "lessons_vec" } as const;

const english = { type: "string", analyzer: "lucene.english" } as const;
const autocomplete = { type: "autocomplete", tokenization: "edgeGram", minGrams: 2, maxGrams: 15, foldDiacritics: true } as const;

export const diagnosesSearchDefinition = {
  mappings: {
    dynamic: false,
    fields: {
      text: english,
      summary: [english, autocomplete],
      causes: { type: "document", fields: { cause: english, fix: english } },
      sceneId: { type: "token" },
      split: { type: "token" },
      faultId: { type: "token" },
      projectId: { type: "token" },
      createdAt: { type: "date" },
    },
  },
};

export const lessonsSearchDefinition = {
  mappings: {
    dynamic: false,
    fields: {
      text: english,
      pattern: [english, autocomplete],
      fix: english,
      active: { type: "boolean" },
      verified: { type: "boolean" },
      createdAt: { type: "date" },
    },
  },
};

/** Filter fields the vector indexes must expose so retrieval can pre-filter (not post-filter) in $vectorSearch. */
export const VECTOR_FILTERS = { lessons: ["active", "verified"], diagnoses: ["split", "sceneId"] } as const;
