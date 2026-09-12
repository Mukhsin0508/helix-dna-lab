import { integrationPaths, integrationSecuritySchemes } from "../shared/integration-openapi.ts";
import { accountPaths, accountSecuritySchemes } from "../shared/account-openapi";
import { analysisPaths, analysisSchemas } from "../shared/analysis-openapi.ts";
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

const predictionJson = (schema: object) => ({ "application/json": { schema } });
const predictionErrorResponse = {
  description: "Sanitized prediction error; provider credentials and raw transport errors are never returned.",
  content: predictionJson({ $ref: "#/components/schemas/PredictionError" }),
};
const predictionJobResponse = {
  description: "Private run status. Completed GET responses include the validated result; export it before the one-hour expiry.",
  content: predictionJson({ $ref: "#/components/schemas/PredictionJob" }),
};
const predictionSecuritySchemes = {
  predictionRunCapability: {
    type: "http", scheme: "bearer", bearerFormat: "64 lowercase hexadecimal characters",
    description: "A caller-generated cryptographically random 256-bit per-run capability. Send as Authorization: Bearer <64 lowercase hex characters>. Keep it out of URLs. This is not an AlphaGenome API key, account session or analytical integration token; no signup is required.",
  },
};
const predictionSchemas = {
  PredictionRequest: {
    type: "object", additionalProperties: false, required: ["requestId", "variantId", "ontologyTerm"],
    description: "One human GRCh38 nuclear SNV and exact tissue for RNA_SEQ. Alleles must differ. The runner verifies the REF base, uses a 1,048,576-base context, rejects chromosome-edge windows and never pads or downsamples.",
    properties: {
      requestId: { type: "string", format: "uuid", description: "Caller-generated idempotency ID. Reuse this ID and the same capability when resuming the same request." },
      variantId: { type: "string", pattern: "^chr(?:[1-9]|1\\d|2[0-2]|X|Y):[1-9]\\d{0,8}:[ACGT]>[ACGT]$", examples: ["chr22:36201698:A>C"] },
      ontologyTerm: { type: "string", pattern: "^(?:UBERON|CL|EFO|CLO|NTR):\\d{4,12}$", maxLength: 80, examples: ["UBERON:0001157"], description: "Must exist in the current hosted RNA-seq track metadata." },
      cropBp: { type: "integer", minimum: 32, maximum: 1024, default: 256 },
    },
  },
  PredictionError: {
    type: "object", required: ["error"], properties: {
      error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } },
    },
  },
  PredictionResult: {
    type: "object", additionalProperties: false, required: ["analysis", "sourceResultJson", "sourceResultSha256"],
    description: "Validated request-bound hosted RNA-seq result. Analysis and raw JSON are each bounded to 2 MiB, and analysis rows to 5000. Retain both artifacts; importing or exporting them does not rerun inference. The raw sidecar preserves native cropped REF/ALT signals and metadata, exact request, SDK version, requested ALL_FOLDS selection and reference-check evidence; internal hosted model/checkpoint revisions remain unreported.",
    properties: {
      analysis: { allOf: [{ $ref: "#/components/schemas/AnalysisDataset" }, { type: "object", properties: { kind: { const: "tracks" } } }] },
      sourceResultJson: { type: "string", description: "Exact UTF-8 JSON text for source-result.json. Preserve verbatim alongside analysis JSON; contains cropped native arrays, not the full 1 Mb outputs." },
      sourceResultSha256: { type: "string", pattern: "^[a-f0-9]{64}$", description: "SHA-256 of the exact UTF-8 sourceResultJson bytes; also recorded in analysis.provenance.artifact.sha256." },
    },
  },
  PredictionJob: {
    type: "object", required: ["jobId", "status"], properties: {
      jobId: { type: "string", format: "uuid" },
      status: { enum: ["starting", "running", "completed", "failed", "expired"] },
      expiresAt: { type: "string", format: "date-time", description: "One hour after run creation; omitted from an already-expired response." },
      result: { $ref: "#/components/schemas/PredictionResult" },
      error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } },
    },
  },
};
const predictionPaths = {
  "/api/predictions/health": {
    get: {
      operationId: "getPredictionHealth", summary: "Check hosted prediction configuration", security: [],
      description: "Read-only configuration check; does not wake the CPU container or call Google. configured means the container binding and a nonempty owner secret exist, not that the key is authorized, inference succeeded or the service is reachable. authenticationVerified is always false for this check.",
      responses: { "200": { description: "Configuration presence only.", content: predictionJson({
        type: "object", required: ["configured", "provider", "authenticationVerified"], properties: {
          configured: { type: "boolean" }, provider: { const: "Google AlphaGenome" }, authenticationVerified: { const: false },
        },
      }) } },
    },
  },
  "/api/predictions": {
    post: {
      operationId: "createPrediction", summary: "Submit a private hosted RNA-seq prediction", security: [{ predictionRunCapability: [] }],
      description: "Optional service requiring the owner's server-side ALPHAGENOME_API_KEY and container binding. No signup or analytical integration token is required. Supply a fresh random per-run capability and exact website Origin. Requests are limited to 2 KiB. The same requestId plus capability resumes one existing run; changing its inputs returns 409. The broker dispatches a run once, while the official SDK can retry retryable Google errors up to five attempts within the 180-second subprocess deadline. Results expire one hour after creation. Only molecular signals are predicted, not clinical or whole-organism outcomes.",
      parameters: [{ name: "Origin", in: "header", required: true, schema: { type: "string", format: "uri" }, description: "Must equal the request URL's origin exactly; the current hosted origin is https://genetic-engineering-lab.higgsfield.app." }],
      requestBody: { required: true, content: predictionJson({ $ref: "#/components/schemas/PredictionRequest" }) },
      responses: {
        "202": { ...predictionJobResponse, description: "New or existing run receipt; use GET with the same capability to retrieve a completed result." },
        "400": predictionErrorResponse, "401": predictionErrorResponse, "403": predictionErrorResponse,
        "409": { ...predictionErrorResponse, description: "The request ID and capability already identify a different input." },
        "410": { ...predictionErrorResponse, description: "This request ID has expired; it is not replayed." },
        "413": predictionErrorResponse, "415": predictionErrorResponse,
        "429": { ...predictionErrorResponse, description: "Concurrent-run, daily or request budget reached. Retry later without creating duplicate submissions." },
        "503": { ...predictionErrorResponse, description: "Owner configuration is missing or the service is unavailable; no example data is substituted." },
      },
    },
  },
  "/api/predictions/{jobId}": {
    get: {
      operationId: "getPrediction", summary: "Poll a private run and retrieve its validated result", security: [{ predictionRunCapability: [] }],
      description: "Use the exact capability supplied at submission. Cookies and analysis tokens grant no run access. If an Origin header is supplied, it must match the request URL's origin. Completed data is retained for one hour from run creation; possession of the job ID alone grants no access. Polling never starts or reruns inference.",
      parameters: [
        { name: "jobId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        { name: "Origin", in: "header", required: false, schema: { type: "string", format: "uri" }, description: "When present, must equal the request URL's origin exactly." },
      ],
      responses: {
        "200": predictionJobResponse, "401": predictionErrorResponse, "403": predictionErrorResponse,
        "404": { ...predictionErrorResponse, description: "Unknown run or incorrect capability; these cases are indistinguishable." },
        "410": { ...predictionJobResponse, description: "Run expired. Returns status expired and a sanitized error; the result is unavailable." },
        "503": predictionErrorResponse,
      },
    },
  },
};

/** Hosted API contract: persistent D1 sessions with shared-link access and optimistic revisions. */
export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Helix Analysis API",
    version: "1.5.0",
    description:
      "Analytical workspace for imported and published AlphaGenome results. Save datasets, figure settings and provenance together; updates use optimistic revisions. Analyses accept up to 5000 rows and 2 MiB per request. New analyses are account-private. Use passkey sessions or scoped access tokens; links alone grant no private access. Legacy unowned analyses are public and read-only. Saved-analysis and historical replay endpoints do not run a model or query Atlas. Separate optional /api/predictions routes can request hosted AlphaGenome RNA-seq inference when the owner configures the server-side key and CPU proxy; they use private per-run capabilities without signup. Configuration status is not proof of successful authentication or inference. Historical replay/session endpoints remain available.",
  },
  servers: [
    {
      url: "https://genetic-engineering-lab.higgsfield.app",
      description: "Public hosted Helix DNA Lab API",
    },
  ],
  paths: {
    ...workspacePaths,
    ...analysisPaths,
    ...accountPaths,
    ...integrationPaths,
    ...predictionPaths,
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
    securitySchemes: { ...accountSecuritySchemes, ...integrationSecuritySchemes, ...predictionSecuritySchemes },
    schemas: {
      ...workspaceSchemas,
      ...analysisSchemas,
      ...predictionSchemas,
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
