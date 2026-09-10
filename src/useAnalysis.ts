import { useCallback, useEffect, useRef, useState } from 'react';
import { analysisCreateSchema, analysisIdSchema, type AnalysisInput, type AnalysisRecord, type FigureSettings } from '../shared/analysis-record';
import type { AnalysisDataset } from '../shared/analysis';
import { DEFAULT_DATASET, defaultSettings } from './analysisUtils';

const CACHE = 'helix-analysis-draft-v1';
interface DraftCache { record?: AnalysisRecord; input: AnalysisInput }
function sameInput(a: AnalysisInput, b: AnalysisInput): boolean { return JSON.stringify({ dataset: a.dataset, settings: a.settings }) === JSON.stringify({ dataset: b.dataset, settings: b.settings }); }
function parseRecord(value: unknown): AnalysisRecord {
  const record = value as AnalysisRecord;
  if (!record || !analysisIdSchema.safeParse(record.id).success || !Number.isSafeInteger(record.revision) || record.revision < 0 || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') throw new Error('The saved analysis is invalid.');
  return { ...analysisCreateSchema.parse({ dataset: record.dataset, settings: record.settings }), id: record.id, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt };
}
function readDraft(): DraftCache | undefined {
  try { const value = JSON.parse(localStorage.getItem(CACHE) || 'null') as DraftCache | null; if (!value) return;
    return { input: analysisCreateSchema.parse(value.input), record: value.record ? parseRecord(value.record) : undefined }; } catch { return; }
}
function updateUrl(id?: string): void {
  const url = new URL(window.location.href); ['analysis', 'workspace', 'candidate', 'session'].forEach(key => url.searchParams.delete(key));
  if (id) url.searchParams.set('analysis', id); window.history.replaceState(window.history.state, '', url);
}
async function api(path: string, method = 'GET', body?: unknown): Promise<{ ok: boolean; status: number; analysis?: AnalysisRecord; message?: string }> {
  const controller = new AbortController(); const timer = window.setTimeout(() => controller.abort(), 12000);
  try { const response = await fetch(path, { method, signal: controller.signal, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The analysis service is unavailable. Your local draft is intact.');
    const value = await response.json(); return { ok: response.ok, status: response.status, analysis: value.analysis ? parseRecord(value.analysis) : undefined, message: value.message };
  } catch (cause) { if (controller.signal.aborted) throw new Error('The save timed out. Your local draft is intact.'); throw cause; }
  finally { clearTimeout(timer); }
}
export function useAnalysis() {
  const [input, setInput] = useState<AnalysisInput>({ dataset: DEFAULT_DATASET, settings: defaultSettings(DEFAULT_DATASET) });
  const [record, setRecord] = useState<AnalysisRecord>();
  const [conflict, setConflict] = useState<AnalysisRecord>();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [ready, setReady] = useState(false);
  const pending = useRef(false); const current = useRef({ input, record }); current.current = { input, record };
  useEffect(() => {
    let active = true; const cached = readDraft(); const id = new URLSearchParams(location.search).get('analysis');
    if (!id) { if (cached) { setInput(cached.input); setRecord(cached.record); if (cached.record) updateUrl(cached.record.id); } setReady(true); return; }
    if (!analysisIdSchema.safeParse(id).success) { setError('This analysis link is invalid. Import a dataset or open the published example.'); setReady(true); return; }
    setBusy(true);
    void api(`/api/analyses/${encodeURIComponent(id)}`).then(response => {
      if (!active) return; if (!response.ok || !response.analysis) throw new Error(response.message || 'This analysis could not be opened.');
      const latest = response.analysis;
      setRecord(latest);
      if (cached?.record?.id === id && !sameInput(cached.input, cached.record)) {
        setInput(cached.input);
        if (cached.record.revision !== latest.revision) { setRecord(cached.record); setConflict(latest); setError('The shared analysis changed. Your local draft is preserved. Save a copy or load the shared version.'); }
      } else setInput({ dataset: latest.dataset, settings: latest.settings });
    }).catch(cause => { if (active) { if (cached?.record?.id === id) { setInput(cached.input); setRecord(cached.record); } setError(cause instanceof Error ? cause.message : 'The analysis could not be opened.'); } })
      .finally(() => { if (active) { setBusy(false); setReady(true); } });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (!ready) return; const timer = setTimeout(() => { try { localStorage.setItem(CACHE, JSON.stringify({ input, record })); } catch { /* The downloadable analysis remains available. */ } }, 200); return () => clearTimeout(timer); }, [input, record, ready]);
  const setSettings = useCallback((patch: Partial<FigureSettings>): void => setInput(previous => ({ ...previous, settings: { ...previous.settings, ...patch } })), []);
  const openDataset = useCallback((dataset: AnalysisDataset, settings?: FigureSettings): void => { if (pending.current || !ready) { setError('Wait for the current save or load before opening another dataset.'); return; } setInput({ dataset, settings: settings || defaultSettings(dataset) }); setRecord(undefined); setConflict(undefined); setError(''); updateUrl(); }, [ready]);
  const save = useCallback(async (asCopy = false): Promise<AnalysisRecord | undefined> => {
    if (pending.current || !ready) return;
    if (conflict && !asCopy) { setError('Save a copy to keep your changes, or load the shared version before editing it.'); return; }
    const snapshot = current.current; const validated = analysisCreateSchema.safeParse(snapshot.input);
    if (!validated.success) { setError(validated.error.issues[0]?.message || 'Check the figure fields before saving.'); return; }
    pending.current = true; setBusy(true); setError('');
    try { const old = asCopy ? undefined : snapshot.record;
      const response = await api(old ? `/api/analyses/${old.id}` : '/api/analyses', old ? 'PATCH' : 'POST', old ? { revision: old.revision, ...validated.data } : validated.data);
      if (!response.ok || !response.analysis) { if (response.status === 409 && response.analysis) setConflict(response.analysis); throw new Error(response.status === 409 ? 'The shared analysis changed. Your draft is preserved. Save a copy or load the shared version.' : response.message || 'The analysis could not be saved.'); }
      setRecord(response.analysis); setInput(previous => sameInput(previous, snapshot.input) ? validated.data : previous); setConflict(undefined); updateUrl(response.analysis.id); return response.analysis;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The save failed. Your local draft is intact.'); return; }
    finally { pending.current = false; setBusy(false); }
  }, [ready, conflict]);
  const loadShared = useCallback((): void => { if (!conflict) return; setRecord(conflict); setInput({ dataset: conflict.dataset, settings: conflict.settings }); setConflict(undefined); setError(''); }, [conflict]);
  return { ...input, record, conflict, dirty: !record || !sameInput(input, record), ready, busy, error, setError, clearError: () => setError(''), setSettings, openDataset, save, loadShared };
}
