import { useCallback, useEffect, useRef, useState } from 'react';
import { startAuthentication, startRegistration, WebAuthnAbortService, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import type { Account, PasskeySummary } from '../shared/account';

const EVENT_KEY = 'helix-account-change';
const CHANNEL = 'helix-account';
function parseAccount(value: unknown): Account {
  const account = value as Account;
  if (!account || typeof account.id !== 'string' || !account.id || typeof account.displayName !== 'string' || !account.displayName) throw new Error('The account response is invalid.');
  return { id: account.id, displayName: account.displayName };
}
async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, 15000);
  try {
    const response = await fetch(`/api/account${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) { const value = await response.json().catch(() => ({})); throw new Error(value.message || 'The account service is unavailable. Try again.'); }
    return response.status === 204 ? undefined as T : await response.json() as T;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
export interface AuthState {
  account: Account | null;
  checked: boolean;
  checking: boolean;
  busy: boolean;
  error: string;
  epoch: number;
  signal: AbortSignal;
  logoutPending: boolean;
  refresh: () => Promise<void>;
  signIn: () => Promise<Account | undefined>;
  register: (displayName: string) => Promise<Account | undefined>;
  addPasskey: () => Promise<Account | undefined>;
  signOut: () => Promise<void>;
  cancel: () => void;
  expire: () => void;
  clearError: () => void;
  listPasskeys: () => Promise<PasskeySummary[]>;
}

/** Only server-verified identity enters the workspace. Broadcasts carry invalidation, never identity. */
export function useAuth(): AuthState {
  const [session, setSession] = useState(() => ({ account: null as Account | null, checked: false, checking: true, epoch: 0, controller: new AbortController() }));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [logoutPending, setLogoutPending] = useState(false);
  const current = useRef(session); current.current = session;
  const serial = useRef(0), active = useRef(true), ceremony = useRef(false), checking = useRef(false), pendingLogout = useRef(false);
  const verification = useRef<'identity' | 'passkey' | null>(null), fenceIdentity = useRef<(() => Promise<void>) | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const replace = useCallback((next: typeof session): void => { current.current = next; if (active.current) setSession(next); }, []);
  const renewSignal = useCallback((): AbortController => {
    current.current.controller.abort(); const controller = new AbortController();
    replace({ ...current.current, controller }); return controller;
  }, [replace]);
  const broadcast = useCallback((phase: 'invalidate' | 'verify'): void => {
    const event = { phase, nonce: crypto.randomUUID() };
    channel.current?.postMessage(event);
    try { localStorage.setItem(EVENT_KEY, JSON.stringify(event)); } catch { /* BroadcastChannel still covers supported tabs. */ }
  }, []);
  const invalidate = useCallback((): void => {
    serial.current++; checking.current = false; ceremony.current = false; verification.current = null; WebAuthnAbortService.cancelCeremony();
    current.current.controller.abort();
    replace({ account: null, checked: false, checking: true, epoch: current.current.epoch + 1, controller: new AbortController() });
    setBusy(false);
  }, [replace]);
  const refresh = useCallback(async (): Promise<void> => {
    if (ceremony.current || checking.current || pendingLogout.current) return;
    checking.current = true; const token = ++serial.current; const controller = renewSignal();
    replace({ ...current.current, checking: true });
    try {
      const value = await request<{ account: unknown }>('', controller.signal);
      if (!active.current || token !== serial.current || controller.signal.aborted) return;
      const account = value.account === null ? null : parseAccount(value.account);
      const changed = current.current.account?.id !== account?.id;
      replace({ ...current.current, account, checked: true, checking: false, epoch: current.current.epoch + (changed ? 1 : 0) });
      setError('');
    } catch (cause) {
      if (!active.current || token !== serial.current) return;
      // A failed verification never restores a cached private workspace.
      const hadAccount = Boolean(current.current.account);
      replace({ ...current.current, account: null, checked: true, checking: false, epoch: current.current.epoch + (hadAccount ? 1 : 0) });
      setError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : 'Account verification failed. Local analysis remains available.');
    } finally { if (token === serial.current) checking.current = false; }
  }, [renewSignal, replace]);
  const cancel = useCallback((): void => {
    if (!ceremony.current) { setError(''); return; }
    // A verify request may have committed even if its response never reached us.
    if (verification.current === 'identity') { void fenceIdentity.current?.(); return; }
    serial.current++; ceremony.current = false; WebAuthnAbortService.cancelCeremony(); renewSignal(); setBusy(false); setError('');
    void refresh();
  }, [refresh, renewSignal]);
  const authenticate = useCallback(async (kind: 'sign-in' | 'register' | 'add', displayName?: string): Promise<Account | undefined> => {
    if (ceremony.current || checking.current || pendingLogout.current) return;
    if (kind === 'add' && !current.current.account) return;
    ceremony.current = true; setBusy(true); setError(''); const token = ++serial.current;
    const controller = renewSignal();
    const originalAccount = current.current.account;
    let verificationStarted = false;
    try {
      const prefix = kind === 'sign-in' ? '/authentication' : kind === 'register' ? '/registration' : '/passkeys';
      const { options } = await request<{ options: PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON }>(`${prefix}/options`, controller.signal, kind === 'register' ? { displayName: displayName?.trim() } : {});
      if (token !== serial.current || controller.signal.aborted) return;
      const response = kind === 'sign-in' ? await startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON }) : await startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON });
      if (token !== serial.current || controller.signal.aborted) return;
      verificationStarted = true;
      verification.current = kind === 'add' ? 'passkey' : 'identity';
      const value = await request<{ account: unknown }>(`${prefix}/verify`, controller.signal, { response });
      if (!active.current || token !== serial.current || controller.signal.aborted) return;
      const account = parseAccount(value.account);
      if (kind === 'add' && account.id !== originalAccount?.id) throw new Error('The account changed. Sign in again before adding a passkey.');
      replace({ ...current.current, account, checked: true, checking: false, epoch: current.current.epoch + (kind !== 'add' ? 1 : 0) });
      if (kind !== 'add') broadcast('verify');
      return account;
    } catch (cause) {
      if (active.current && token === serial.current) {
        if (verificationStarted && kind !== 'add') { await fenceIdentity.current?.(); return; }
        if (verificationStarted) { invalidate(); void refresh(); }
        setError(cause instanceof Error && cause.name !== 'NotAllowedError' && cause.name !== 'AbortError' ? cause.message : 'Passkey request cancelled. You can try again.');
      }
      return;
    } finally { if (token === serial.current) { ceremony.current = false; verification.current = null; setBusy(false); } }
  }, [broadcast, invalidate, refresh, renewSignal, replace]);
  const signOut = useCallback(async (notice = ''): Promise<void> => {
    pendingLogout.current = true; setLogoutPending(true); invalidate(); setError(''); setBusy(true); broadcast('invalidate');
    const token = serial.current, controller = current.current.controller;
    try {
      await request('/logout', controller.signal, {});
      if (!active.current || token !== serial.current) return;
      pendingLogout.current = false; setLogoutPending(false); replace({ ...current.current, checked: true, checking: false }); setError(notice); broadcast('verify');
    } catch { if (active.current && token === serial.current) { replace({ ...current.current, checked: true, checking: false }); setError('Your local session is cleared, but server sign-out was not confirmed. Retry sign out.'); } }
    finally { if (active.current && token === serial.current) setBusy(false); }
  }, [broadcast, invalidate, replace]);
  fenceIdentity.current = () => signOut('Sign-in was not completed; try again.');
  const expire = useCallback((): void => { invalidate(); void refresh(); }, [invalidate, refresh]);
  const listPasskeys = useCallback(async (): Promise<PasskeySummary[]> => {
    if (!current.current.account || current.current.checking) return [];
    const token = serial.current;
    const value = await request<{ passkeys: PasskeySummary[] }>('/passkeys', current.current.controller.signal);
    if (token !== serial.current || !active.current) return [];
    if (!Array.isArray(value.passkeys)) throw new Error('Passkeys could not be loaded.');
    return value.passkeys;
  }, []);
  useEffect(() => {
    active.current = true; void refresh();
    const seen = new Set<string>();
    const changed = (value: unknown): void => {
      const event = value as { phase?: string; nonce?: string };
      if (!event || !['invalidate', 'verify'].includes(event.phase || '') || typeof event.nonce !== 'string' || seen.has(event.nonce)) return;
      seen.add(event.nonce); if (seen.size > 30) seen.delete(seen.values().next().value!);
      invalidate();
      if (event.phase === 'invalidate') {
        pendingLogout.current = true; setLogoutPending(true);
        replace({ ...current.current, checked: true, checking: false });
        setError('Your account is signing out in another tab. If it does not finish, retry sign out.');
      } else { pendingLogout.current = false; setLogoutPending(false); void refresh(); }
    };
    const storage = (event: StorageEvent): void => { if (event.key === EVENT_KEY && event.newValue) { try { changed(JSON.parse(event.newValue)); } catch { /* Invalid messages grant no access. */ } } };
    const focus = (): void => { if (document.visibilityState !== 'hidden') void refresh(); };
    const hide = (): void => { if (ceremony.current) return; current.current.controller.abort(); replace({ ...current.current, checking: true }); };
    if (typeof BroadcastChannel !== 'undefined') { channel.current = new BroadcastChannel(CHANNEL); channel.current.onmessage = event => changed(event.data); }
    window.addEventListener('storage', storage); window.addEventListener('focus', focus); window.addEventListener('pageshow', focus); window.addEventListener('pagehide', hide); document.addEventListener('visibilitychange', focus);
    return () => { active.current = false; serial.current++; current.current.controller.abort(); WebAuthnAbortService.cancelCeremony(); checking.current = false; ceremony.current = false; channel.current?.close(); channel.current = null; window.removeEventListener('storage', storage); window.removeEventListener('focus', focus); window.removeEventListener('pageshow', focus); window.removeEventListener('pagehide', hide); document.removeEventListener('visibilitychange', focus); };
  }, [invalidate, refresh, replace]);
  return { account: session.account, checked: session.checked, checking: session.checking, epoch: session.epoch, signal: session.controller.signal, busy, error, logoutPending, refresh, signIn: () => authenticate('sign-in'), register: name => authenticate('register', name), addPasskey: () => authenticate('add'), signOut: () => signOut(), cancel, expire, clearError: () => setError(''), listPasskeys };
}
