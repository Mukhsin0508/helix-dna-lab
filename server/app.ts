import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z, ZodError } from "zod";
import { DEFAULT_EXPERIMENT, EXPERIMENTS } from "../shared/experiments.ts";
import type {
  ExperimentDefinition,
  LabSession,
  SessionPatch,
} from "../shared/types.ts";
import { openApiDocument } from "./openapi.ts";
import { SessionStore } from "./store.ts";
import { registerWorkspaceRoutes } from "./workbench.ts";
import { registerAnalysisRoutes } from "./analyses.ts";

const baseSchema = z.enum(["A", "C", "G", "T"]);
const revisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const sessionIdSchema = z.string().uuid();
const createSchema = z
  .object({ experimentId: z.string().min(1).max(100).optional() })
  .strict();
const patchSchema = z
  .object({
    selectedIndex: z.number().int().nonnegative().optional(),
    alternate: baseSchema.optional(),
    view: z.enum(["cell", "dna", "rna"]).optional(),
    compare: z.boolean().optional(),
    progress: z.number().min(0).max(1).optional(),
    revision: revisionSchema,
  })
  .strict() satisfies z.ZodType<SessionPatch>;
const actionSchema = z.object({ revision: revisionSchema.optional() }).strict();

function findExperiment(id: string): ExperimentDefinition | undefined {
  return EXPERIMENTS.find((experiment) => experiment.id === id);
}

function conflict(
  reply: FastifyReply,
  session: LabSession | undefined,
): FastifyReply {
  return reply
    .code(409)
    .send({
      error: "revision_conflict",
      message:
        "This session changed. Reload its latest revision before saving.",
      session,
    });
}

/** Creates a local API with an explicit database path, also usable by request-injection tests. */
export async function createApp(dbPath: string): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 16 * 1024,
    logger: false,
    trustProxy: false,
  });
  const store = new SessionStore(dbPath, EXPERIMENTS);
  const clients = new Map<string, { count: number; resetsAt: number }>();

  app.addHook("onClose", async () => {
    store.close();
  });
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    const now = Date.now();
    let client = clients.get(request.ip);
    if (!client || client.resetsAt <= now) {
      if (clients.size >= 10_000) {
        for (const [ip, entry] of clients)
          if (entry.resetsAt <= now) clients.delete(ip);
        if (clients.size >= 10_000)
          clients.delete(clients.keys().next().value!);
      }
      client = { count: 0, resetsAt: now + 60_000 };
      clients.set(request.ip, client);
    }
    client.count += 1;
    if (client.count > 300) {
      reply.header("Retry-After", Math.ceil((client.resetsAt - now) / 1000));
      return reply
        .code(429)
        .send({
          error: "rate_limit",
          message: "Too many requests. Please retry shortly.",
        });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send({
          error: "validation_error",
          message: "The request contains invalid fields.",
          details: error.issues.map(({ path, message }) => ({
            field: path.join("."),
            message,
          })),
        });
    }
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    return reply
      .code(statusCode >= 400 && statusCode < 500 ? statusCode : 500)
      .send({
        error:
          statusCode === 413
            ? "body_too_large"
            : statusCode < 500
              ? "invalid_request"
              : "internal_error",
        message:
          statusCode < 500
            ? "The request could not be accepted."
            : "The local API could not complete this request.",
      });
  });

  function loadSession(
    id: string,
    reply: FastifyReply,
  ): LabSession | undefined {
    const session = store.get(sessionIdSchema.parse(id));
    if (!session)
      reply
        .code(404)
        .send({
          error: "session_not_found",
          message: "This local session does not exist.",
        });
    return session;
  }

  app.get("/api/health", async () => ({
    status: "ok",
    storage: "sqlite",
    mode: "local",
    predictionMode: "curated-replay",
  }));
  app.get("/api/experiments", async () => EXPERIMENTS);
  app.get("/api/openapi.json", async () => openApiDocument);

  registerWorkspaceRoutes(app, dbPath);
  registerAnalysisRoutes(app, dbPath);

  app.post("/api/sessions", async (request, reply) => {
    const body = createSchema.parse(request.body ?? {});
    const experiment = body.experimentId
      ? findExperiment(body.experimentId)
      : DEFAULT_EXPERIMENT;
    if (!experiment)
      return reply
        .code(400)
        .send({
          error: "unknown_experiment",
          message: "Choose an experiment from /api/experiments.",
        });
    return reply.code(201).send({ session: store.create(experiment) });
  });

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      const session = loadSession(request.params.id, reply);
      if (session) return { session };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      const patch = patchSchema.parse(request.body);
      const session = loadSession(request.params.id, reply);
      if (!session) return;
      if (patch.revision !== session.revision) return conflict(reply, session);
      const experiment = findExperiment(session.experimentId)!;
      if (
        patch.selectedIndex !== undefined &&
        patch.selectedIndex >= experiment.referenceSequence.length
      ) {
        return reply
          .code(400)
          .send({
            error: "index_out_of_range",
            message: `selectedIndex must be between 0 and ${experiment.referenceSequence.length - 1}.`,
          });
      }
      const { revision: _revision, ...changes } = patch;
      const variantChanged =
        (patch.selectedIndex !== undefined &&
          patch.selectedIndex !== session.selectedIndex) ||
        (patch.alternate !== undefined &&
          patch.alternate !== session.alternate);
      const updated = store.update(
        session,
        variantChanged ? { ...changes, status: "ready", progress: 0 } : changes,
      );
      return updated
        ? { session: updated }
        : conflict(reply, store.get(session.id));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/run",
    async (request, reply) => {
      const body = actionSchema.parse(request.body ?? {});
      const session = loadSession(request.params.id, reply);
      if (!session) return;
      if (body.revision !== undefined && body.revision !== session.revision)
        return conflict(reply, session);
      const experiment = findExperiment(session.experimentId)!;
      const isUnchanged =
        session.alternate === experiment.referenceSequence[session.selectedIndex];
      const isCuratedVariant =
        !isUnchanged &&
        session.selectedIndex === experiment.defaultIndex &&
        session.alternate === experiment.alternate;
      const updated = store.update(session, {
        status: isUnchanged
          ? "unchanged"
          : isCuratedVariant
            ? "replayed"
            : "unscored",
        progress: 0,
        ...(isCuratedVariant ? { view: "rna" as const, compare: true } : {}),
      });
      return updated
        ? { session: updated }
        : conflict(reply, store.get(session.id));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/reset",
    async (request, reply) => {
      const body = actionSchema.parse(request.body ?? {});
      const session = loadSession(request.params.id, reply);
      if (!session) return;
      if (body.revision !== undefined && body.revision !== session.revision)
        return conflict(reply, session);
      const experiment = findExperiment(session.experimentId)!;
      const updated = store.update(session, {
        selectedIndex: experiment.defaultIndex,
        alternate: experiment.alternate,
        view: "dna",
        compare: false,
        progress: 0,
        status: "ready",
      });
      return updated
        ? { session: updated }
        : conflict(reply, store.get(session.id));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/export",
    async (request, reply) => {
      const session = loadSession(request.params.id, reply);
      if (!session) return;
      const experiment = findExperiment(session.experimentId)!;
      const exported = {
        format: "dna-lab-session",
        version: "1.0",
        exportedAt: new Date().toISOString(),
        session,
        experiment,
        scientificProvenance: {
          mode: session.status === "unchanged"
            ? "unchanged reference control"
            : "curated educational replay",
          liveModelUsed: false,
          sequenceKind: experiment.sequenceKind,
          sequenceNotice:
            experiment.sequenceKind === "illustrative"
              ? "This displayed sequence is illustrative and must not be interpreted as a genomic reference coordinate."
              : "The displayed sequence is a reference excerpt; consult its cited source for coordinates and assembly.",
          result:
            session.status === "replayed"
              ? "The selected edit matches this curated educational example. Its mechanism is replayed from cited evidence; no live prediction or numeric score was generated."
              : session.status === "unchanged"
                ? "The selected alternate is identical to the reference base. The DNA sequence is unchanged: this is a reference control, not a mutation. No model was called and no molecular or organism-level effect was inferred."
                : session.status === "unscored"
                  ? "This edit has no model result. No molecular or organism-level effect has been inferred."
                  : "This session has not run its current edit.",
          evidence: experiment.evidence,
          limitation: experiment.limitation,
          sources: experiment.sources,
        },
      };
      return reply
        .type("application/json; charset=utf-8")
        .header(
          "Content-Disposition",
          `attachment; filename="dna-lab-${session.id}.json"`,
        )
        .send(JSON.stringify(exported, null, 2));
    },
  );

  const distPath = fileURLToPath(new URL("../dist/", import.meta.url));
  if (existsSync(`${distPath}/index.html`)) {
    await app.register(fastifyStatic, { root: distPath });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !request.url.startsWith("/api/") &&
        !request.url.split("?")[0].includes(".")
      ) {
        return reply.sendFile("index.html");
      }
      return reply
        .code(404)
        .send({ error: "not_found", message: "This route does not exist." });
    });
  }
  return app;
}
