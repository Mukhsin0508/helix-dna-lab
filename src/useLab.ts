import { useCallback, useEffect, useRef, useState } from "react";
import { request, RequestError } from "./apiClient";
import type {
  ExperimentDefinition,
  LabSession,
  SessionEnvelope,
  SessionPatch,
} from "../shared/types";

function savedSession(): string | null {
  try {
    return localStorage.getItem("helix-session");
  } catch {
    return null;
  }
}

// Reuse initialization across React StrictMode's mount check without creating duplicate sessions.
let initialization:
  | Promise<{ session: LabSession; experiment: ExperimentDefinition }>
  | undefined;
async function initialize(): Promise<{
  session: LabSession;
  experiment: ExperimentDefinition;
}> {
  const experiments = await request<ExperimentDefinition[]>("/api/experiments");
  const explicitId = new URLSearchParams(location.search).get("session");
  const savedId = explicitId || savedSession();
  let session: LabSession | undefined;
  if (savedId) {
    try {
      session = (
        await request<SessionEnvelope>(
          `/api/sessions/${encodeURIComponent(savedId)}`,
        )
      ).session;
    } catch (error) {
      if (
        explicitId ||
        !(error instanceof RequestError) ||
        ![400, 404].includes(error.status)
      )
        throw error;
    }
  }
  session ??= (await request<SessionEnvelope>("/api/sessions", "POST", {}))
    .session;
  const experiment = experiments.find(
    (item) => item.id === session!.experimentId,
  );
  if (!experiment) throw new Error("This experiment is unavailable.");
  try {
    localStorage.setItem("helix-session", session.id);
  } catch {
    // Storage may be disabled; the session URL still restores the server record.
  }
  const url = new URL(location.href);
  url.searchParams.set("session", session.id);
  history.replaceState(null, "", url);
  return { session, experiment };
}

export function useLab() {
  const [session, setSession] = useState<LabSession>();
  const [experiment, setExperiment] = useState<ExperimentDefinition>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(true);
  const current = useRef<LabSession | undefined>(undefined);
  const pending = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const alive = useRef(true);
  const accept = useCallback((next: LabSession) => {
    if (!alive.current) return;
    current.current = next;
    setSession(next);
    setConnected(true);
  }, []);

  useEffect(() => {
    alive.current = true;
    initialization ??= initialize().catch((error) => {
      initialization = undefined;
      throw error;
    });
    void initialization
      .then((result) => {
        if (alive.current) {
          accept(result.session);
          setExperiment(result.experiment);
        }
      })
      .catch((error) => {
        if (alive.current) setError(error.message);
      });
    const timer = window.setInterval(() => {
      if (!current.current || pending.current || document.hidden) return;
      const startRevision = current.current.revision;
      void request<SessionEnvelope>(`/api/sessions/${current.current.id}`)
        .then(({ session: next }) => {
          if (!alive.current) return;
          setConnected(true);
          if (
            !pending.current &&
            current.current?.revision === startRevision &&
            next.revision > startRevision
          )
            accept(next);
        })
        .catch(() => {
          if (alive.current) setConnected(false);
        });
    }, 2500);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [accept]);

  const mutate = useCallback(
    (
      action: "patch" | "run" | "reset",
      patch: Omit<SessionPatch, "revision"> = {},
    ) => {
      pending.current += 1;
      setBusy(true);
      setError("");
      const operation = chain.current.then(
        async (): Promise<LabSession | undefined> => {
          try {
            if (!current.current) return;
            const { id, revision } = current.current;
            const { session: next } = await request<SessionEnvelope>(
              `/api/sessions/${id}${action === "patch" ? "" : `/${action}`}`,
              action === "patch" ? "PATCH" : "POST",
              { ...patch, revision },
            );
            accept(next);
            return next;
          } catch (error) {
            if (error instanceof RequestError && error.status === 0)
              setConnected(false);
            if (
              error instanceof RequestError &&
              error.status === 409 &&
              error.session
            ) {
              accept(error.session);
              setError(
                "This session changed in another window. Latest version loaded; try your change again.",
              );
            } else
              setError(
                error instanceof Error
                  ? error.message
                  : "Connection interrupted. Try again.",
              );
          } finally {
            pending.current -= 1;
            if (alive.current) setBusy(pending.current > 0);
          }
        },
      );
      chain.current = operation;
      return operation;
    },
    [accept],
  );

  return {
    session,
    experiment,
    error,
    busy,
    connected,
    mutate,
    clearError: () => setError(""),
  };
}
