import { useCallback, useEffect, useRef, useState } from "react";
import { request, RequestError } from "./apiClient";
import type {
  ExperimentDefinition,
  LabSession,
  SessionEnvelope,
  SessionPatch,
} from "../shared/types";

interface InitializedLab {
  session: LabSession;
  experiment: ExperimentDefinition;
}

export interface UseLabOptions {
  /** Stable workspace/candidate key. Replay sessions are isolated from legacy shared session URLs. */
  replayKey?: string;
}

type StoredReplay = Pick<LabSession,
  "experimentId" | "selectedIndex" | "alternate" | "view" | "compare" | "progress" | "status"
>;

function replayStorageKey(key: string): string { return `helix-replay-state:${key}`; }

/** Store only a confirmed replay snapshot, never a server capability ID shared by cloned tabs. */
function rememberReplay(key: string, session: LabSession): void {
  const { experimentId, selectedIndex, alternate, view, compare, progress, status } = session;
  try {
    window.sessionStorage.setItem(replayStorageKey(key), JSON.stringify({
      experimentId, selectedIndex, alternate, view, compare, progress, status,
    } satisfies StoredReplay));
  } catch { /* A session remains usable when browser storage is disabled. */ }
}

function storedReplay(key: string, experiment: ExperimentDefinition): StoredReplay | undefined {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(replayStorageKey(key)) || "null");
    if (typeof value !== "object" || value === null) return undefined;
    const saved = value as Partial<StoredReplay>;
    if (saved.experimentId !== experiment.id
      || !Number.isInteger(saved.selectedIndex)
      || saved.selectedIndex! < 0 || saved.selectedIndex! >= experiment.referenceSequence.length
      || !["A", "C", "G", "T"].includes(saved.alternate || "")
      || !["cell", "dna", "rna"].includes(saved.view || "")
      || typeof saved.compare !== "boolean"
      || typeof saved.progress !== "number" || !Number.isFinite(saved.progress) || saved.progress < 0 || saved.progress > 1
      || !["ready", "replayed", "unscored", "unchanged"].includes(saved.status || "")) return undefined;
    return saved as StoredReplay;
  } catch { return undefined; }
}

/** Restore state into a new session so different tabs can never fight over a replay ID. */
async function initializeReplay(key: string): Promise<InitializedLab> {
  const experiments = await request<ExperimentDefinition[]>("/api/experiments");
  let session = (await request<SessionEnvelope>("/api/sessions", "POST", {})).session;
  const experiment = experiments.find(item => item.id === session.experimentId);
  if (!experiment) throw new Error("This experiment is unavailable.");
  const saved = storedReplay(key, experiment);
  if (saved) {
    const path = `/api/sessions/${session.id}`;
    session = (await request<SessionEnvelope>(path, "PATCH", {
      revision: session.revision,
      selectedIndex: saved.selectedIndex,
      alternate: saved.alternate,
      view: saved.view,
      compare: saved.compare,
      progress: 0,
    })).session;
    if (saved.status !== "ready") {
      // The API recomputes curated/unchanged/unscored classification; saved browser data is not evidence.
      session = (await request<SessionEnvelope>(`${path}/run`, "POST", { revision: session.revision })).session;
      session = (await request<SessionEnvelope>(path, "PATCH", {
        revision: session.revision,
        view: saved.view,
        compare: saved.compare,
        progress: session.status === "replayed" && saved.status === "replayed" ? saved.progress : 0,
      })).session;
    }
  }
  return { session, experiment };
}

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

export function useLab({ replayKey }: UseLabOptions = {}) {
  const [session, setSession] = useState<LabSession>();
  const [experiment, setExperiment] = useState<ExperimentDefinition>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(true);
  const current = useRef<LabSession | undefined>(undefined);
  const pending = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const alive = useRef(true);
  const isolatedInitialization = useRef<{ key: string; promise: Promise<InitializedLab> } | undefined>(undefined);
  const accept = useCallback((next: LabSession) => {
    if (!alive.current) return;
    current.current = next;
    setSession(next);
    setConnected(true);
    if (replayKey) rememberReplay(replayKey, next);
  }, [replayKey]);

  useEffect(() => {
    alive.current = true;
    let ready: Promise<InitializedLab>;
    if (replayKey) {
      // This ref survives StrictMode's effect check, but not a candidate remount.
      if (isolatedInitialization.current?.key !== replayKey) {
        isolatedInitialization.current = { key: replayKey, promise: initializeReplay(replayKey) };
      }
      ready = isolatedInitialization.current.promise;
    } else {
      initialization ??= initialize().catch((error) => {
        initialization = undefined;
        throw error;
      });
      ready = initialization;
    }
    let active = true;
    void ready
      .then((result) => {
        if (active && alive.current) {
          accept(result.session);
          setExperiment(result.experiment);
        }
      })
      .catch((error) => {
        if (active && alive.current) setError(error.message);
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
      active = false;
      alive.current = false;
      clearInterval(timer);
    };
  }, [accept, replayKey]);

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
