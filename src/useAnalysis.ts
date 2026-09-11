import { useCallback, useEffect, useRef, useState } from 'react';
import { analysisCreateSchema, analysisIdSchema, type AnalysisAccess, type AnalysisInput, type AnalysisList, type AnalysisRecord, type AnalysisSummary, type FigureSettings } from '../shared/analysis-record';
import type { AnalysisDataset } from '../shared/analysis';
import { DEFAULT_DATASET, defaultSettings } from './analysisUtils';
import type { AuthState } from './useAuth';

function sameInput(a: AnalysisInput, b: AnalysisInput): boolean { return JSON.stringify({ dataset: a.dataset, settings: a.settings }) === JSON.stringify({ dataset: b.dataset, settings: b.settings }); }
function parseRecord(value: unknown): AnalysisRecord {
  const record = value as AnalysisRecord;
  if (!record || !analysisIdSchema.safeParse(record.id).success || !Number.isSafeInteger(record.revision) || record.revision < 0 || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') throw new Error('The saved analysis is invalid.');
  return { ...analysisCreateSchema.parse({ dataset: record.dataset, settings: record.settings }), id: record.id, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt };
}
function parseAccess(value: unknown): AnalysisAccess {
  const access = value as AnalysisAccess;
  if (!access || !((access.mode === 'owner' && access.canWrite === true) || (access.mode === 'legacy-public' && access.canWrite === false))) throw new Error('The analysis access response is invalid.');
  return { mode: access.mode, canWrite: access.canWrite };
}
function updateUrl(id?: string): void {
  const url = new URL(window.location.href); ['analysis', 'workspace', 'candidate', 'session'].forEach(key => url.searchParams.delete(key));
  if (id) url.searchParams.set('analysis', id); window.history.replaceState(window.history.state, '', url);
}
interface ApiResponse { ok: boolean; status: number; analysis?: AnalysisRecord; access?: AnalysisAccess; analyses?: AnalysisSummary[]; nextCursor?: string | null; message?: string }
async function api(path: string, signal: AbortSignal, method = 'GET', body?: unknown): Promise<ApiResponse> {
  const controller = new AbortController(); let timedOut = false;
  const abort = (): void => controller.abort(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, 15000);
  try {
    const response = await fetch(path, { method, signal: controller.signal, credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.status === 204) return { ok: response.ok, status: 204 };
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The analysis service is unavailable. Export your draft to keep a local copy.');
    const value = await response.json();
    return { ok: response.ok, status: response.status, analysis: value.analysis ? parseRecord(value.analysis) : undefined, access: value.analysis ? parseAccess(value.access) : undefined, analyses: value.analyses, nextCursor: value.nextCursor, message: value.message };
  } catch (cause) { if (timedOut && !signal.aborted) throw new Error('The request timed out. Your open draft is unchanged.'); throw cause; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

/** Private analyses live only in this account-scoped mount; never in browser storage. */
export function useAnalysis(auth: AuthState, handoff?: AnalysisInput) {
  const [input, setInput] = useState<AnalysisInput>(() => handoff || { dataset: DEFAULT_DATASET, settings: defaultSettings(DEFAULT_DATASET) });
  const [record, setRecord] = useState<AnalysisRecord>(), [access, setAccess] = useState<AnalysisAccess>(), [conflict, setConflict] = useState<AnalysisRecord>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [loadAttempt, setLoadAttempt] = useState(0);
  const alive = useRef(true), initialized = useRef(false), pending = useRef(false), operations = useRef(new Set<AbortController>());
  const authRef = useRef(auth); authRef.current = auth;
  const current = useRef({ input, record, access, conflict }); current.current = { input, record, access, conflict };
  useEffect(() => {
    alive.current = true;
    // Discard the pre-account global cache. It cannot establish ownership or safe provenance.
    try { localStorage.removeItem('helix-analysis-draft-v1'); } catch { /* Storage may be unavailable. */ }
    return () => { alive.current = false; operations.current.forEach(controller => controller.abort()); operations.current.clear(); };
  }, []);
  const begin = useCallback(() => {
    const identity = authRef.current.account?.id; const session = authRef.current.signal;
    const controller = new AbortController(); const abort = (): void => controller.abort();
    session.addEventListener('abort', abort, { once: true }); if (session.aborted) abort();
    operations.current.add(controller);
    return { signal: controller.signal, valid: () => alive.current && !controller.signal.aborted && !session.aborted && identity === authRef.current.account?.id, done: () => { session.removeEventListener('abort', abort); operations.current.delete(controller); } };
  }, []);
  const checkResponse = useCallback((response: ApiResponse): void => {
    if (response.status === 401 && authRef.current.account) authRef.current.expire();
    if (response.access?.mode === 'owner' && !authRef.current.account) throw new Error('Sign in to open this private analysis.');
  }, []);
  const openSaved = useCallback(async (id: string): Promise<boolean> => {
    if (pending.current || !authRef.current.checked || authRef.current.checking || authRef.current.logoutPending) return false;
    if (!analysisIdSchema.safeParse(id).success) { setError('This analysis link is invalid.'); return false; }
    pending.current = true; setBusy(true); setError(''); const task = begin();
    try {
      const response = await api(`/api/analyses/${encodeURIComponent(id)}`, task.signal); if (!task.valid()) return false;
      checkResponse(response);
      if (!response.ok || !response.analysis || !response.access) throw new Error(response.message || (response.status === 401 ? 'Sign in with the owning account to open this analysis.' : 'This analysis is unavailable to this account.'));
      setRecord(response.analysis); setAccess(response.access); setInput({ dataset: response.analysis.dataset, settings: response.analysis.settings }); setConflict(undefined); updateUrl(id); return true;
    } catch (cause) { if (task.valid()) setError(cause instanceof Error ? cause.message : 'The analysis could not be opened.'); return false; }
    finally { task.done(); pending.current = false; if (alive.current) { setBusy(false); setReady(true); } }
  }, [begin, checkResponse]);
  useEffect(() => {
    if (initialized.current || !auth.checked || auth.checking) return;
    if (auth.logoutPending) { setReady(true); return; }
    initialized.current = true;
    if (handoff) { updateUrl(); setReady(true); return; }
    const id = new URLSearchParams(location.search).get('analysis');
    if (!id) { setReady(true); return; }
    const initialSignal = auth.signal;
    void openSaved(id).then(() => { if (alive.current && (initialSignal.aborted || initialSignal !== authRef.current.signal)) { initialized.current = false; setLoadAttempt(value => value + 1); } });
  }, [auth.checked, auth.checking, auth.signal, auth.logoutPending, handoff, openSaved, loadAttempt]);
  const setSettings = useCallback((patch: Partial<FigureSettings>): void => { if (!authRef.current.checking && alive.current) setInput(previous => ({ ...previous, settings: { ...previous.settings, ...patch } })); }, []);
  const openDataset = useCallback((dataset: AnalysisDataset, settings?: FigureSettings): void => {
    if (pending.current || !ready || authRef.current.checking) { setError('Wait for the current save or load before opening another dataset.'); return; }
    setInput({ dataset, settings: settings || defaultSettings(dataset) }); setRecord(undefined); setAccess(undefined); setConflict(undefined); setError(''); updateUrl();
  }, [ready]);
  const save = useCallback(async (asCopy = false): Promise<AnalysisRecord | undefined> => {
    if (pending.current || !ready || authRef.current.checking) return;
    if (!authRef.current.account) { setError('Sign in to save a private analysis.'); return; }
    const snapshot = current.current;
    if (snapshot.conflict && !asCopy) { setError('Save a copy to keep your changes, or load the saved version.'); return; }
    const validated = analysisCreateSchema.safeParse(snapshot.input);
    if (!validated.success) { setError(validated.error.issues[0]?.message || 'Check the figure fields before saving.'); return; }
    pending.current = true; setBusy(true); setError(''); const task = begin();
    try {
      const old = asCopy || !snapshot.access?.canWrite ? undefined : snapshot.record;
      const response = await api(old ? `/api/analyses/${old.id}` : '/api/analyses', task.signal, old ? 'PATCH' : 'POST', old ? { revision: old.revision, ...validated.data } : validated.data);
      if (!task.valid()) return; checkResponse(response);
      if (!response.ok || !response.analysis || !response.access) {
        if (response.status === 409 && response.analysis) { setConflict(response.analysis); setAccess(response.access); }
        throw new Error(response.status === 409 ? 'The saved analysis changed. Your draft is preserved. Save a copy or load the saved version.' : response.message || 'The analysis could not be saved.');
      }
      setRecord(response.analysis); setAccess(response.access); setInput(previous => sameInput(previous, snapshot.input) ? validated.data : previous); setConflict(undefined); updateUrl(response.analysis.id); return response.analysis;
    } catch (cause) { if (task.valid()) setError(cause instanceof Error ? cause.message : 'The save failed. Your open draft is unchanged.'); return; }
    finally { task.done(); pending.current = false; if (alive.current) setBusy(false); }
  }, [begin, checkResponse, ready]);
  const loadShared = useCallback((): void => { const value = current.current.conflict; if (!value || authRef.current.checking) return; setRecord(value); setInput({ dataset: value.dataset, settings: value.settings }); setConflict(undefined); setError(''); }, []);
  const listAnalyses = useCallback(async (cursor?: string): Promise<AnalysisList> => {
    if (!authRef.current.account || authRef.current.checking) throw new Error('Sign in to view your analyses.');
    const task = begin();
    try {
      const response = await api(`/api/analyses?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, task.signal);
      if (!task.valid()) throw new DOMException('Account changed.', 'AbortError'); checkResponse(response);
      if (!response.ok || !Array.isArray(response.analyses) || !(response.nextCursor === null || typeof response.nextCursor === 'string')) throw new Error(response.message || 'Your analyses could not be loaded.');
      return { analyses: response.analyses, nextCursor: response.nextCursor };
    } finally { task.done(); }
  }, [begin, checkResponse]);
  const deleteAnalysis = useCallback(async (item: AnalysisSummary): Promise<boolean> => {
    if (!authRef.current.account || authRef.current.checking || pending.current) return false;
    pending.current = true; setBusy(true); const task = begin();
    try {
      const response = await api(`/api/analyses/${encodeURIComponent(item.id)}`, task.signal, 'DELETE', { revision: item.revision });
      if (!task.valid()) return false; checkResponse(response);
      if (!response.ok) throw new Error(response.status === 409 ? 'This analysis changed. Reload the list before deleting it.' : response.message || 'The analysis could not be deleted.');
      if (current.current.record?.id === item.id) { setInput({ dataset: DEFAULT_DATASET, settings: defaultSettings(DEFAULT_DATASET) }); setRecord(undefined); setAccess(undefined); setConflict(undefined); updateUrl(); }
      return true;
    } finally { task.done(); pending.current = false; if (alive.current) setBusy(false); }
  }, [begin, checkResponse]);
  return { ...input, record, access, conflict, dirty: !record || !sameInput(input, record), ready, busy, error, setError, clearError: () => setError(''), setSettings, openDataset, openSaved, save, loadShared, listAnalyses, deleteAnalysis };
}
