import { useCallback, useEffect, useRef, useState } from 'react';
import { analysisIdSchema, type AnalysisAccess, type AnalysisInput, type AnalysisRecord, type FigureSettings } from '../shared/analysis-record';
import type { AnalysisDataset } from '../shared/analysis';
import { DEFAULT_DATASET, defaultSettings } from './analysisUtils';
import { createLocalAnalysisStorage, validateLocalAnalysis, type LocalAnalysisStorage, type WorkspaceStorageStatus } from './localAnalysisStorage';

function updateUrl(): void {
  const url = new URL(window.location.href);
  ['analysis', 'id', 'workspace', 'candidate', 'session'].forEach(key => url.searchParams.delete(key));
  window.history.replaceState(window.history.state, '', url);
}

/** Cookie-free public source loading is the only network operation in this hook. */
export async function loadPublicAnalysis(id: string, signal: AbortSignal): Promise<AnalysisRecord> {
  if (!analysisIdSchema.safeParse(id).success) throw new Error('This analysis link is invalid.');
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort(); }, 15000);
  try {
    const response = await fetch(`/api/analyses/${encodeURIComponent(id)}`, { signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error('This link is not a public analysis. Your local workspace is unchanged.');
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The public analysis service is unavailable.');
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024 + 4096) throw new Error('The public analysis exceeds the supported size.');
    const envelope = JSON.parse(body) as { analysis?: AnalysisRecord; access?: AnalysisAccess };
    // Reject private/owner data even if a misconfigured service returns it without cookies.
    if (envelope.access?.mode !== 'legacy-public' || envelope.access.canWrite !== false) throw new Error('Only public analyses can be opened in this workspace.');
    const record = envelope.analysis;
    if (!record || record.id !== id || !Number.isSafeInteger(record.revision) || record.revision < 0 || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error('The public analysis response is invalid.');
    return { ...validateLocalAnalysis({ dataset: record.dataset, settings: record.settings }), id, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt };
  } catch (cause) {
    if (timedOut && !signal.aborted) throw new Error('The public analysis request timed out. Your local workspace is unchanged.');
    if (cause instanceof SyntaxError) throw new Error('The public analysis response is invalid.');
    throw cause;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

/** An anonymous, local workspace. It never reads or mutates an account session. */
export function useAnalysis() {
  const [input, setInput] = useState<AnalysisInput>(() => ({ dataset: DEFAULT_DATASET, settings: defaultSettings(DEFAULT_DATASET) }));
  const [record, setRecord] = useState<AnalysisRecord>();
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const [storageStatus, setStorageStatus] = useState<WorkspaceStorageStatus>('memory-only');
  const [exportController, setExportController] = useState(() => new AbortController());
  const exportRef = useRef(exportController), storage = useRef<LocalAnalysisStorage | undefined>(undefined);
  const mounted = useRef(false), lifecycle = useRef(0), intent = useRef(0), saveVersion = useRef(0);
  const loadController = useRef<AbortController | undefined>(undefined), current = useRef(input), restoreFailed = useRef(false);
  current.current = input;

  const replaceExportScope = useCallback((): void => {
    exportRef.current.abort();
    exportRef.current = new AbortController();
    setExportController(exportRef.current);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const mount = ++lifecycle.current, initialIntent = intent.current;
    const store = createLocalAnalysisStorage(); storage.current = store;
    const controller = new AbortController(); loadController.current = controller;
    if (exportRef.current.signal.aborted) replaceExportScope();
    const valid = (): boolean => mounted.current && lifecycle.current === mount && intent.current === initialIntent && !controller.signal.aborted;
    const query = new URLSearchParams(window.location.search), id = query.get('analysis') || query.get('id');
    setBusy(Boolean(id));
    void (async () => {
      const restored = store.load().then(value => ({ value, failed: false }), () => ({ value: undefined, failed: true }));
      const publicResult = id ? loadPublicAnalysis(id, controller.signal).then(value => ({ value, error: '' }), cause => ({ value: undefined, error: cause instanceof Error ? cause.message : 'The public analysis could not be opened.' })) : Promise.resolve({ value: undefined, error: '' });
      const [local, source] = await Promise.all([restored, publicResult]);
      if (!valid()) return;
      restoreFailed.current = local.failed && !source.value;
      if (source.value) {
        replaceExportScope(); setRecord(source.value); setInput({ dataset: source.value.dataset, settings: source.value.settings });
      } else if (local.value) {
        replaceExportScope(); setInput(local.value); setRecord(undefined);
      }
      if (source.error) { setError(source.error); updateUrl(); }
      else if (local.failed) setError('Browser storage is unavailable or its draft is invalid. Export JSON to keep this workspace.');
      setStorageStatus(local.failed ? 'unavailable' : 'memory-only');
      setBusy(false); setReady(true);
    })();
    return () => {
      mounted.current = false; controller.abort(); exportRef.current.abort(); store.close();
      if (storage.current === store) storage.current = undefined;
    };
  }, [replaceExportScope]);

  useEffect(() => {
    if (!ready || !storage.current) return;
    // A broken read must never advance a pointer over the recoverable old draft.
    if (restoreFailed.current) { setStorageStatus('unavailable'); return; }
    const store = storage.current, mount = lifecycle.current, version = ++saveVersion.current;
    let parsed: AnalysisInput;
    try { parsed = validateLocalAnalysis(input); }
    catch { setStorageStatus('memory-only'); return; }
    setStorageStatus('saving');
    const timer = setTimeout(() => {
      void store.save(parsed).then(() => {
        if (mounted.current && lifecycle.current === mount && saveVersion.current === version) setStorageStatus('saved');
      }, () => {
        if (mounted.current && lifecycle.current === mount && saveVersion.current === version) setStorageStatus('unavailable');
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [input, ready]);

  const overridePendingLoad = useCallback((): void => {
    intent.current += 1; saveVersion.current += 1; restoreFailed.current = false;
    loadController.current?.abort(); setBusy(false); setReady(true); setStorageStatus('saving');
  }, []);
  const setSettings = useCallback((patch: Partial<FigureSettings>): void => {
    if (!mounted.current) return;
    overridePendingLoad(); updateUrl();
    // Transient edits such as an empty title remain visible but are never persisted.
    const next = { ...current.current, settings: { ...current.current.settings, ...patch } };
    current.current = next; setInput(next);
  }, [overridePendingLoad]);
  const openDataset = useCallback((dataset: AnalysisDataset, settings?: FigureSettings): void => {
    if (!mounted.current) return;
    let next: AnalysisInput;
    try { next = validateLocalAnalysis({ dataset, settings: settings || defaultSettings(dataset) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'This analysis is invalid.'); return; }
    overridePendingLoad(); replaceExportScope(); updateUrl();
    current.current = next; setInput(next); setRecord(undefined); setError('');
  }, [overridePendingLoad, replaceExportScope]);
  const clearError = useCallback((): void => setError(''), []);
  const access: AnalysisAccess | undefined = record ? { mode: 'legacy-public', canWrite: false } : undefined;
  const dirty = !record || JSON.stringify(input) !== JSON.stringify({ dataset: record.dataset, settings: record.settings });
  return { ...input, record, access, dirty, ready, busy, error, setError, clearError, setSettings, openDataset, exportSignal: exportController.signal, storageStatus };
}
