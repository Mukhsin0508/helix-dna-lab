import { analysisCreateSchema, ANALYSIS_BODY_LIMIT, analysisIdSchema, type AnalysisInput } from '../shared/analysis-record';

export type WorkspaceStorageStatus = 'saved' | 'saving' | 'unavailable' | 'memory-only';
export const LOCAL_WORKSPACE_DB = 'helix-local-workspaces-v1';
export const LOCAL_WORKSPACE_POINTER = 'helix-local-workspace-v1';
const STORE = 'workspaces';
const META = 'metadata';
const STORAGE_TIMEOUT_MS = 5000;

export interface LocalAnalysisStorage {
  load(): Promise<AnalysisInput | undefined>;
  save(input: AnalysisInput): Promise<void>;
  close(): void;
}

/** Apply the same scientific validation and payload limit used by saved analyses. */
export function validateLocalAnalysis(value: unknown): AnalysisInput {
  const parsed = analysisCreateSchema.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || 'The analysis is invalid.');
  if (new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > ANALYSIS_BODY_LIMIT) throw new Error('The analysis exceeds the 2 MB limit.');
  return parsed.data;
}

interface StoredAnalysis { format: 'helix-local-workspace'; version: 1; input: AnalysisInput }
export function readStoredAnalysis(value: unknown): AnalysisInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The browser draft could not be restored.');
  const record = value as Record<string, unknown>;
  if (record.format !== 'helix-local-workspace' || record.version !== 1 || Object.keys(record).some(key => !['format', 'version', 'input'].includes(key))) throw new Error('The browser draft format is unsupported.');
  // This namespace intentionally does not accept account records or ownership envelopes.
  return validateLocalAnalysis(record.input);
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = factory.open(LOCAL_WORKSPACE_DB, 1);
    const timer = setTimeout(() => { settled = true; reject(new Error('Browser storage did not respond.')); }, STORAGE_TIMEOUT_MS);
    const fail = (): void => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Browser storage is unavailable.')); } };
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      if (!request.result.objectStoreNames.contains(META)) request.result.createObjectStore(META);
    };
    request.onerror = fail;
    request.onblocked = fail;
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true; clearTimeout(timer);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser storage did not respond.')), STORAGE_TIMEOUT_MS);
    request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
    request.onerror = () => { clearTimeout(timer); reject(new Error('The browser draft could not be read.')); };
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { transaction.abort(); } catch { /* Already settled. */ } reject(new Error('Browser storage did not respond.')); }, STORAGE_TIMEOUT_MS);
    transaction.oncomplete = () => { clearTimeout(timer); resolve(); };
    const fail = (): void => { clearTimeout(timer); reject(new Error('The browser could not save this workspace. Export JSON to keep a copy.')); };
    transaction.onabort = fail;
    transaction.onerror = fail;
  });
}

/**
 * Each document writes its own branch. Reloads and duplicated tabs read the old
 * branch once, then write a fresh key, so another open tab cannot overwrite it.
 * Only the input is persisted; public/account access metadata is never cached.
 */
export function createLocalAnalysisStorage(): LocalAnalysisStorage {
  let db: Promise<IDBDatabase> | undefined;
  let closed = false;
  const writeKey = crypto.randomUUID();
  let restoreKey: string | null = null;
  let tabStorageAvailable = true;
  try {
    restoreKey = window.sessionStorage.getItem(LOCAL_WORKSPACE_POINTER);
    const probe = `${LOCAL_WORKSPACE_POINTER}:probe:${writeKey}`;
    window.sessionStorage.setItem(probe, '1'); window.sessionStorage.removeItem(probe);
  } catch { tabStorageAvailable = false; }
  const database = (): Promise<IDBDatabase> => {
    if (closed) return Promise.reject(new Error('This browser workspace is closed.'));
    // Without a durable per-tab pointer, another tab's latest draft would replace
    // this one on reload. Keep the workspace usable but do not claim it is saved.
    if (!tabStorageAvailable) return Promise.reject(new Error('Per-tab browser storage is unavailable.'));
    if (!db) {
      try {
        if (!window.indexedDB) throw new Error('Browser storage is unavailable.');
        db = openDatabase(window.indexedDB);
      } catch { db = Promise.reject(new Error('Browser storage is unavailable.')); }
    }
    return db;
  };
  return {
    async load() {
      const connection = await database();
      let key = restoreKey;
      if (!key || !analysisIdSchema.safeParse(key).success) key = await requestValue(connection.transaction(META, 'readonly').objectStore(META).get('latest')) as string | undefined || null;
      if (!key || !analysisIdSchema.safeParse(key).success) return undefined;
      const value: unknown = await requestValue(connection.transaction(STORE, 'readonly').objectStore(STORE).get(key));
      return value === undefined ? undefined : readStoredAnalysis(value);
    },
    async save(input) {
      const validated = validateLocalAnalysis(input);
      const connection = await database();
      if (closed) throw new Error('This browser workspace is closed.');
      const transaction = connection.transaction([STORE, META], 'readwrite');
      const completed = transactionDone(transaction);
      const value: StoredAnalysis = { format: 'helix-local-workspace', version: 1, input: validated };
      try {
        transaction.objectStore(STORE).put(value, writeKey);
        transaction.objectStore(META).put(writeKey, 'latest');
      } catch {
        try { transaction.abort(); } catch { /* Transaction may already be inactive. */ }
        await completed.catch(() => undefined);
        throw new Error('The browser could not save this workspace. Export JSON to keep a copy.');
      }
      await completed;
      // Never point at data until its complete transaction committed.
      restoreKey = writeKey;
      try { window.sessionStorage.setItem(LOCAL_WORKSPACE_POINTER, writeKey); }
      catch { tabStorageAvailable = false; throw new Error('The browser could not remember this workspace. Export JSON to keep a copy.'); }
    },
    close() { closed = true; if (db) void db.then(connection => connection.close(), () => undefined); },
  };
}
