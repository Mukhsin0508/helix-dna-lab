const sessionReference = { $ref: "#/components/schemas/Session" };
const errorResponse = {
  description: "Request rejected.",
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/Error" } },
  },
};
const sessionResponse = {
  description: "Current persisted session.",
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["session"],
        properties: { session: sessionReference },
      },
    },
  },
};
const idParameter = [
  {
    name: "id",
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
    description: "UUID of a session stored on this local server.",
  },
];
const actionBody = {
  required: false,
  content: {
    "application/json": {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          revision: {
            type: "integer",
            minimum: 0,
            description: "When supplied, rejects stale updates with 409.",
          },
        },
      },
    },
  },
};

/** Portable API contract; authentication must be added before any public deployment. */
export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "DNA Lab API",
    version: "1.0.0",
    description:
      "Local educational DNA explorer. Sessions persist in SQLite and use optimistic revisions. Runs replay a curated cited mechanism only for its predefined edit; all other edits are unscored. This API does not call AlphaGenome or generate scientific scores. The current server listens only on 127.0.0.1, has no authentication, and is not a public session-sharing service. Add authentication and authorization before public deployment. Request bodies are limited to 16 KiB; API clients are limited to 300 requests per minute per IP.",
  },
  servers: [
    {
      url: "http://127.0.0.1:4191",
      description: "Local development or local production server",
    },
  ],
  paths: {
    "/api/health": {
      get: {
        operationId: "getHealth",
        summary: "Check API availability",
        responses: {
          "200": {
            description:
              "API is running with local SQLite storage and curated replay mode.",
          },
        },
      },
    },
    "/api/experiments": {
      get: {
        operationId: "listExperiments",
        summary: "Read curated experiments and their evidence",
        responses: {
          "200": {
            description: "Experiment definitions.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Experiment" },
                },
              },
            },
          },
        },
      },
    },
    "/api/sessions": {
      post: {
        operationId: "createSession",
        summary: "Create an independent local session",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  experimentId: {
                    type: "string",
                    minLength: 1,
                    maxLength: 100,
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": sessionResponse,
          "400": errorResponse,
          "413": errorResponse,
          "429": errorResponse,
        },
      },
    },
    "/api/sessions/{id}": {
      parameters: idParameter,
      get: {
        operationId: "getSession",
        summary: "Read the current session",
        responses: {
          "200": sessionResponse,
          "400": errorResponse,
          "404": errorResponse,
        },
      },
      patch: {
        operationId: "updateSession",
        summary: "Save fields using the last known revision",
        description:
          "Changing selectedIndex or alternate clears any previous result and sets progress to zero. selectedIndex is zero-based within the displayed sequence, not a chromosome coordinate.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SessionPatch" },
            },
          },
        },
        responses: {
          "200": sessionResponse,
          "400": errorResponse,
          "404": errorResponse,
          "409": {
            description:
              "Revision conflict; response includes the current session. Refetch or reconcile before retrying.",
          },
          "413": errorResponse,
          "429": errorResponse,
        },
      },
    },
    "/api/sessions/{id}/run": {
      parameters: idParameter,
      post: {
        operationId: "runSession",
        summary:
          "Replay the curated example or mark an arbitrary edit unscored",
        description:
          "Only an exact match of the experiment defaultIndex and alternate returns status replayed. Other edits return unscored. Both finish the educational playback at progress 1. No model inference or numeric effect score is generated.",
        requestBody: actionBody,
        responses: {
          "200": sessionResponse,
          "400": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
        },
      },
    },
    "/api/sessions/{id}/reset": {
      parameters: idParameter,
      post: {
        operationId: "resetSession",
        summary: "Restore experiment defaults while retaining this session ID",
        description:
          "Resets view to dna, compare to false, progress to zero and status to ready. Revision increments.",
        requestBody: actionBody,
        responses: {
          "200": sessionResponse,
          "400": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
        },
      },
    },
    "/api/sessions/{id}/export": {
      parameters: idParameter,
      get: {
        operationId: "exportSession",
        summary:
          "Download readable JSON with session, experiment and scientific provenance",
        responses: {
          "200": {
            description:
              "A formatted JSON attachment. scientificProvenance explicitly records liveModelUsed=false, sequence kind, limitations, cited sources and whether this edit has a curated replay.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: [
                    "format",
                    "version",
                    "exportedAt",
                    "session",
                    "experiment",
                    "scientificProvenance",
                  ],
                  properties: {
                    format: { const: "dna-lab-session" },
                    version: { const: "1.0" },
                    exportedAt: { type: "string", format: "date-time" },
                    session: sessionReference,
                    experiment: { $ref: "#/components/schemas/Experiment" },
                    scientificProvenance: {
                      type: "object",
                      properties: {
                        liveModelUsed: { const: false },
                        result: { type: "string" },
                        sources: {
                          type: "array",
                          items: {
                            $ref: "#/components/schemas/EvidenceSource",
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": errorResponse,
          "404": errorResponse,
        },
      },
    },
    "/api/openapi.json": {
      get: {
        operationId: "getApiContract",
        summary: "Read this OpenAPI contract",
        responses: { "200": { description: "OpenAPI 3.1 document." } },
      },
    },
  },
  components: {
    schemas: {
      Error: {
        type: "object",
        required: ["error", "message"],
        properties: {
          error: { type: "string" },
          message: { type: "string" },
          session: sessionReference,
          details: {
            type: "array",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
      },
      EvidenceSource: {
        type: "object",
        required: ["title", "url"],
        properties: {
          title: { type: "string" },
          url: { type: "string", format: "uri" },
        },
      },
      Experiment: {
        type: "object",
        required: [
          "id",
          "gene",
          "title",
          "tissue",
          "referenceSequence",
          "sequenceKind",
          "defaultIndex",
          "alternate",
          "summary",
          "mechanism",
          "evidence",
          "limitation",
          "sources",
        ],
        properties: {
          id: { type: "string" },
          gene: { type: "string" },
          title: { type: "string" },
          tissue: { type: "string" },
          referenceSequence: { type: "string", pattern: "^[ACGT]+$" },
          sequenceKind: { enum: ["illustrative", "reference"] },
          defaultIndex: { type: "integer", minimum: 0 },
          alternate: { enum: ["A", "C", "G", "T"] },
          summary: { type: "string" },
          mechanism: { type: "string" },
          evidence: { type: "string" },
          limitation: { type: "string" },
          sources: {
            type: "array",
            items: { $ref: "#/components/schemas/EvidenceSource" },
          },
        },
      },
      Session: {
        type: "object",
        required: [
          "id",
          "experimentId",
          "selectedIndex",
          "alternate",
          "view",
          "compare",
          "progress",
          "status",
          "revision",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          experimentId: { type: "string" },
          selectedIndex: {
            type: "integer",
            minimum: 0,
            description: "Zero-based index in the displayed example sequence.",
          },
          alternate: { enum: ["A", "C", "G", "T"] },
          view: { enum: ["cell", "dna", "rna"] },
          compare: { type: "boolean" },
          progress: { type: "number", minimum: 0, maximum: 1 },
          status: { enum: ["ready", "replayed", "unscored"] },
          revision: { type: "integer", minimum: 0 },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      SessionPatch: {
        type: "object",
        additionalProperties: false,
        required: ["revision"],
        properties: {
          selectedIndex: { type: "integer", minimum: 0 },
          alternate: { enum: ["A", "C", "G", "T"] },
          view: { enum: ["cell", "dna", "rna"] },
          compare: { type: "boolean" },
          progress: { type: "number", minimum: 0, maximum: 1 },
          revision: { type: "integer", minimum: 0 },
        },
      },
    },
  },
};
