import { workspacePaths, workspaceSchemas } from "../shared/workbench-openapi";

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
    description: "Unguessable UUID of a session persisted in D1. Anyone with this ID or its session link can read, change, and export the session; it is a shared-link capability, not account authentication.",
  },
];
const actionBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["revision"],
        properties: {
          revision: {
            type: "integer",
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
            description: "Required current session revision. Stale updates are rejected with 409 and the latest session is returned.",
          },
        },
      },
    },
  },
};

/** Hosted API contract: persistent D1 sessions with shared-link access and optimistic revisions. */
export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Helix Workspace API",
    version: "1.1.0",
    description:
      "Hosted educational DNA explorer served over public HTTPS. Sessions persist in Cloudflare D1. New sessions and resets open in cell view. Every PATCH, run, and reset requires the current revision; an atomic revision check prevents concurrent clients from overwriting each other. Runs return unchanged when the alternate matches the reference base, replayed for the predefined curated mutation, and unscored for other mutations. This API does not call AlphaGenome or generate scientific scores. There is no account authentication: an unguessable session UUID or link is a shared capability, and anyone holding it can read, change, and export that session. Browser mutations must have a same-origin Origin header when one is supplied. Request bodies are limited to 16 KiB. Session requests share a fixed-window budget of 180 requests per minute per client IP; health, experiment discovery, and this schema endpoint are exempt. A 429 response includes Retry-After: 60.",
  },
  servers: [
    {
      url: "https://helix-dna-lab.higgsfield.app",
      description: "Public hosted Helix DNA Lab API",
    },
  ],
  paths: {
    ...workspacePaths,
    "/api/health": {
      get: {
        operationId: "getHealth",
        summary: "Check API availability",
        responses: {
          "200": {
            description:
              "API can access persistent D1 session storage and is operating in hosted curated replay mode.",
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
        summary: "Create an independent persisted session",
        description: "Creates a session with revision 0, view cell, compare false, progress 0, and status ready. Returns its unguessable UUID; sharing the session URL grants read and edit access to that session.",
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
          "Identify an unchanged reference control, replay the curated example, or mark another mutation unscored",
        description:
          "Requires a JSON body with the current revision. An alternate identical to the reference base at selectedIndex returns unchanged: the sequence has not mutated. Otherwise, only an exact match of the experiment defaultIndex and alternate returns replayed; this atomically sets view to rna and compare to true, ready to begin playback. Other mutations return unscored. Every run starts progress at 0. The replayed status identifies available curated evidence, not playback completion. No model is called, and no numeric effect score is generated for any result.",
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
          "Requires a JSON body with the current revision. Restores the experiment default index and alternate, resets view to cell, compare to false, progress to zero and status to ready, and increments the revision. The session ID and creation time are retained.",
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
              "A formatted JSON attachment. scientificProvenance records liveModelUsed=false, sequence kind, limitations, cited sources and the result. An unchanged result explicitly identifies a reference control with no DNA mutation and no inferred biological effect.",
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
      ...workspaceSchemas,
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
          status: { enum: ["ready", "replayed", "unscored", "unchanged"] },
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
