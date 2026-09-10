import { useCallback, useEffect, useRef, useState } from "react";
import { request, RequestError } from "./apiClient";
import {
  candidatesSchema,
  workspaceSchema,
  type Candidate,
  type Workspace,
  type WorkspaceEnvelope,
} from "../shared/workbench";

const initializations = new Map<string, Promise<Workspace>>();

function savedId(): string | null {
  try { return window.localStorage.getItem("helix-workspace"); }
  catch { return null; }
}

/** Runs only from an effect, so loading the component during SSR accesses no browser globals. */
async function initialize(explicitId: string | null, rememberedId: string | null): Promise<Workspace> {
  const id = explicitId || rememberedId;
  let workspace: Workspace | undefined;
  if (id) {
    try {
      workspace = workspaceSchema.parse((await request<WorkspaceEnvelope>(`/api/workspaces/${encodeURIComponent(id)}`)).workspace);
    } catch (error) {
      // A broken explicit capability link should remain visible rather than silently opening a different record.
      if (explicitId || !(error instanceof RequestError) || ![400, 404].includes(error.status)) throw error;
    }
  }
  workspace ??= workspaceSchema.parse((await request<WorkspaceEnvelope>("/api/workspaces", "POST", {})).workspace);
  return workspace;
}

export interface WorkbenchState {
  workspace: Workspace | undefined;
  error: string;
  busy: boolean;
  saveCandidates: (candidates: Candidate[]) => Promise<boolean>;
  clearError: () => void;
}

/** Saved alternatives with explicit revision checks; unsaved edits stay with the caller. */
export function useWorkbench(): WorkbenchState {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const current = useRef<Workspace | undefined>(undefined);
  const pending = useRef(false);
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    const explicitId = new URLSearchParams(window.location.search).get("workspace");
    const rememberedId = explicitId ? null : savedId();
    const key = explicitId || rememberedId || "new";
    let initialization = initializations.get(key);
    if (!initialization) {
      initialization = initialize(explicitId, rememberedId);
      initializations.set(key, initialization);
      // Deduplicate only requests in flight. A later mount must load the latest server revision.
      void initialization.finally(() => { initializations.delete(key); }).catch(() => undefined);
    }
    void initialization.then(next => {
      if (!alive.current) return;
      current.current = next;
      setWorkspace(next);
      try { window.localStorage.setItem("helix-workspace", next.id); }
      catch { /* The capability URL can still restore the saved record. */ }
      const url = new URL(window.location.href);
      url.searchParams.set("workspace", next.id);
      window.history.replaceState(window.history.state, "", url);
    }).catch(cause => {
      if (alive.current) setError(cause instanceof Error ? cause.message : "The workspace could not be opened. Reload to try again.");
    }).finally(() => {
      if (alive.current) setBusy(false);
    });
    return () => { alive.current = false; };
  }, []);

  const saveCandidates = useCallback(async (candidates: Candidate[]): Promise<boolean> => {
    if (pending.current) {
      setError("A save is still in progress. This change has not been saved; try again after it finishes.");
      return false;
    }
    const previous = current.current;
    if (!previous) {
      setError("Open a workspace before saving changes.");
      return false;
    }
    const validated = candidatesSchema.safeParse(candidates);
    if (!validated.success) {
      setError(validated.error.issues[0]?.message || "Check the candidate fields before saving.");
      return false;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const next = workspaceSchema.parse((await request<WorkspaceEnvelope>(`/api/workspaces/${previous.id}`, "PATCH", {
        revision: previous.revision,
        candidates: validated.data,
      })).workspace);
      if (alive.current) {
        current.current = next;
        setWorkspace(next);
      }
      return true;
    } catch (cause) {
      if (alive.current) setError(cause instanceof RequestError && cause.status === 409
        ? "This workspace changed in another window. Your current view and unsaved edits are preserved. Copy your edits before reloading the latest version."
        : cause instanceof RequestError && cause.status === 413
          ? "These notes exceed the save size limit. Shorten the notes or use fewer alternatives, then save again."
          : cause instanceof Error ? cause.message : "The change was not saved. Try again.");
      return false;
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => { setError(""); }, []);
  return { workspace, error, busy, saveCandidates, clearError };
}
