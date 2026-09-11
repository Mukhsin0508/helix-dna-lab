import { useEffect, useRef, useState } from 'react';
import { Fingerprint, KeyRound, Plus, X } from 'lucide-react';
import type { Account, PasskeySummary } from '../../shared/account';
import type { AuthState } from '../useAuth';
import IntegrationTokens from './IntegrationTokens';

export default function AuthDialog({ auth, onClose, onAuthenticated, intent = 'account' }: { auth: AuthState; onClose: () => void; onAuthenticated: (account: Account) => void; intent?: 'account' | 'save' }) {
  const [mode, setMode] = useState<'signin' | 'register'>('signin'), [name, setName] = useState('');
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]), [listError, setListError] = useState(''), [loadingKeys, setLoadingKeys] = useState(false);
  const container = useRef<HTMLDivElement>(null), first = useRef<HTMLInputElement>(null), closeRef = useRef(onClose), active = useRef(true); closeRef.current = onClose;
  useEffect(() => {
    active.current = true; const previous = document.activeElement as HTMLElement | null;
    container.current?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const items = [...(container.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]') || [])].filter(item => item.offsetParent !== null);
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { active.current = false; document.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { if (mode === 'register') first.current?.focus(); }, [mode]);
  const loadKeys = async (): Promise<void> => {
    setLoadingKeys(true); setListError('');
    try { const keys = await auth.listPasskeys(); if (active.current) setPasskeys(keys); }
    catch (cause) { if (active.current && !(cause instanceof Error && cause.name === 'AbortError')) setListError(cause instanceof Error ? cause.message : 'Passkeys could not be loaded.'); }
    finally { if (active.current) setLoadingKeys(false); }
  };
  useEffect(() => { if (auth.account) void loadKeys(); }, [auth.account?.id]);
  async function submit(): Promise<void> {
    const account = mode === 'register' ? await auth.register(name) : await auth.signIn();
    if (account) onAuthenticated(account);
  }
  async function add(): Promise<void> { const account = await auth.addPasskey(); if (account && active.current) await loadKeys(); }
  const title = auth.account ? 'Your account' : mode === 'register' ? 'Create account' : 'Sign in';
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="modal account-dialog" role="dialog" aria-modal="true" aria-label={title} ref={container}>
    <div className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="Close account dialog" onClick={onClose}><X size={18}/></button></div>
    <div className="modal-body">
      {auth.account ? <><div className="account-identity"><Fingerprint size={25}/><div><strong>{auth.account.displayName}</strong><span>Analyses are private to your account.</span></div></div><div className="account-section-heading"><h3>Passkeys</h3><button className="button" data-initial-focus disabled={auth.busy || auth.checking} onClick={() => { void add(); }}><Plus size={14}/>Add passkey</button></div><p className="field-hint">Add another passkey while you can sign in. There is no email recovery.</p>{loadingKeys ? <p role="status">Loading passkeys…</p> : <ul className="passkey-list">{passkeys.map((key, index) => <li key={key.id}><KeyRound size={16}/><div><strong>Passkey {index + 1}</strong><span>{key.deviceType === 'multiDevice' ? 'Multi-device' : 'Single-device'} · {key.backedUp ? 'Backed up' : 'Not backed up'}<br/>Added {new Date(key.createdAt).toLocaleDateString('en-GB')}{key.lastUsedAt ? ` · Last used ${new Date(key.lastUsedAt).toLocaleDateString('en-GB')}` : ''}</span></div></li>)}</ul>}{listError && <div className="import-error" role="alert">{listError}<button className="template-link" onClick={() => { void loadKeys(); }}>Retry</button></div>}<IntegrationTokens auth={auth}/></>
      : <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="account-intro"><Fingerprint size={30}/><p>{intent === 'save' ? 'Sign in to save this analysis privately.' : 'Keep your analyses in your own workspace.'}</p></div>
        <div className="import-types" aria-label="Account action"><button type="button" data-initial-focus className={mode === 'signin' ? 'active' : ''} disabled={auth.busy} onClick={() => { setMode('signin'); auth.clearError(); }}>Sign in</button><button type="button" className={mode === 'register' ? 'active' : ''} disabled={auth.busy} onClick={() => { setMode('register'); auth.clearError(); }}>Create account</button></div>
        {mode === 'register' && <label className="field"><span>Display name</span><input ref={first} autoComplete="nickname" aria-label="Display name" value={name} onChange={event => setName(event.target.value)} required maxLength={80} disabled={auth.busy}/></label>}
        <p className="field-hint">Use your device or password manager to {mode === 'register' ? 'create a passkey' : 'sign in with a passkey'}. No password or email is required.</p>
        {mode === 'register' && <p className="field-hint">Keep your passkey available. There is no email recovery.</p>}
        <button className="button primary auth-submit" type="submit" disabled={auth.busy || auth.checking || auth.logoutPending || (mode === 'register' && !name.trim())}>{auth.busy ? <span className="load-spinner"/> : <KeyRound size={16}/>} {auth.busy ? 'Waiting for your passkey…' : mode === 'register' ? 'Create account with passkey' : 'Sign in with passkey'}</button>
      </form>}
      {auth.error && <div className="import-error" role="alert">{auth.error}</div>}
    </div>
    <div className="modal-footer"><span className="sharing-note">{auth.account ? 'Only your account can open private links.' : 'Importing, plotting and exporting work without an account.'}</span><button className="button" onClick={onClose}>{auth.busy ? 'Cancel' : 'Done'}</button></div>
  </div></div>;
}
