const id = { type: "string", format: "uuid" };
const revision = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const response = {
  description: "Server-confirmed workspace. This stores comparison setups, not prediction results.",
  content: { "application/json": { schema: { type: "object", required: ["workspace"], properties: { workspace: { $ref: "#/components/schemas/Workspace" } } } } },
};
const errors = {
  "400": { description: "Invalid input or duplicate candidate IDs." },
  "413": { description: "Request exceeds the shared 16 KiB body limit." },
  "429": { description: "Request budget exceeded." },
};

/** Common workspace contract for the local and hosted adapters. */
export const workspacePaths = {
  "/api/workspaces": {
    post: {
      operationId: "createWorkspace",
      summary: "Create a saved comparison workspace",
      description: "Creates a capability link for public evidence and research notes. Anyone possessing its ID can read and edit it. No private genomic uploads or model inference.",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false } } } },
      responses: { "201": response, ...errors },
    },
  },
  "/api/workspaces/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: id }],
    get: {
      operationId: "getWorkspace", summary: "Read saved alternatives",
      responses: { "200": response, "404": { description: "Unknown workspace." }, ...errors },
    },
    patch: {
      operationId: "updateWorkspace", summary: "Replace alternatives using the current revision",
      description: "Atomic optimistic update. Preserve unsaved edits on a 409 and reconcile against the returned current workspace. Saving never executes a biological model.",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["revision", "candidates"], properties: { revision, candidates: { type: "array", minItems: 1, maxItems: 20, items: { $ref: "#/components/schemas/Candidate" } } } } } } },
      responses: { "200": response, "404": { description: "Unknown workspace." }, "409": { description: "Stale revision; includes the current workspace." }, ...errors },
    },
  },
};

export const workspaceSchemas = {
  Candidate: {
    type: "object", additionalProperties: false,
    required: ["id", "title", "question", "scenario", "intervention", "selectedIndex", "alternate", "notes", "createdAt"],
    properties: {
      id, title: { type: "string", minLength: 1, maxLength: 80 }, question: { type: "string", minLength: 1, maxLength: 500 },
      scenario: { enum: ["sickle-cell", "dnm1"] }, intervention: { enum: ["baseline", "intervention"] },
      selectedIndex: { type: "integer", minimum: 0, maximum: 40 }, alternate: { enum: ["A", "C", "G", "T"] },
      notes: { type: "string", maxLength: 3000 }, createdAt: { type: "string", format: "date-time" },
    },
    allOf: [{ if: { properties: { scenario: { const: "sickle-cell" } } }, then: { properties: { selectedIndex: { const: 20 }, alternate: { const: "A" } } } }],
  },
  Workspace: {
    type: "object", additionalProperties: false,
    required: ["id", "revision", "candidates", "createdAt", "updatedAt"],
    properties: { id, revision, candidates: { type: "array", minItems: 1, maxItems: 20, items: { $ref: "#/components/schemas/Candidate" } }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" } },
  },
};
