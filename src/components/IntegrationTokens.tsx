import { useEffect, useRef, useState } from 'react';
import { Check, Copy, KeyRound, Plus, X } from 'lucide-react';
import type { AuthState } from '../useAuth';
import type { IntegrationTokenSummary as TokenSummary } from '../../shared/integration-tokens';

interface RevealedToken { value: string; details: TokenSummary; owner: string; epoch: number; signal: AbortSignal }
function parseSummary(value: unknown): TokenSummary {
  const item = value as TokenSummary;
  if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 200 || typeof item.label !== 'string' || !item.label || item.label.length > 200 || !Array.isArray(item.scopes) || !item.scopes.length || item.scopes.some(scope => scope !== 'analyses:read' && scope !== 'analyses:write') || new Set(item.scopes).size !== item.scopes.length || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || typeof item.expiresAt !== 'string' || !Number.isFinite(Date.parse(item.expiresAt)) || !(item.lastUsedAt === null || (typeof item.lastUsedAt === 'string' && Number.isFinite(Date.parse(item.lastUsedAt))))) throw new Error('The access token response is invalid.');
  return { id: item.id, label: item.label, scopes: item.scopes, createdAt: item.createdAt, expiresAt: item.expiresAt, lastUsedAt: item.lastUsedAt };
}
function date(value: string): string { return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }

/** Secrets exist only in this verified account dialog; storage and list responses never contain them. */
export default function IntegrationTokens({ auth }: { auth: AuthState }) {
  const [tokens, setTokens] = useState<TokenSummary[]>([]), [revealed, setRevealed] = useState<RevealedToken | null>(null);
  const [listOwner, setListOwner] = useState<{ id: string; epoch: number } | null>(null);
  const [form, setForm] = useState(false), [label, setLabel] = useState('AllMCP'), [access, setAccess] = useState<'read' | 'write'>('read'), [days, setDays] = useState<7 | 30 | 90>(30);
  const [loading, setLoading] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [copied, setCopied] = useState(false), [revokeId, setRevokeId] = useState<string | null>(null);
  const active = useRef(true), pending = useRef(false), requests = useRef(new Set<AbortController>()), authRef = useRef(auth), field = useRef<HTMLInputElement>(null), tokenField = useRef<HTMLTextAreaElement>(null);
  authRef.current = auth;
  const available = Boolean(auth.account && auth.checked && !auth.checking && !auth.busy && !auth.logoutPending && !auth.signal.aborted);
  const visibleSecret = available && revealed && revealed.owner === auth.account?.id && revealed.epoch === auth.epoch && revealed.signal === auth.signal && !revealed.signal.aborted ? revealed : null;
  const visibleTokens = available && listOwner?.id === auth.account?.id && listOwner?.epoch === auth.epoch ? tokens : [];
  useEffect(() => { active.current = true; return () => { active.current = false; requests.current.forEach(controller => controller.abort()); requests.current.clear(); }; }, []);
  useEffect(() => { if (form) field.current?.focus(); }, [form]);
  useEffect(() => { if (visibleSecret) tokenField.current?.focus(); }, [visibleSecret]);

  function begin() {
    const owner = authRef.current.account?.id, epoch = authRef.current.epoch, signal = authRef.current.signal;
    const controller = new AbortController(); const abort = (): void => controller.abort(); let timedOut = false;
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); requests.current.add(controller);
    const timer = setTimeout(() => { timedOut = true; abort(); }, 15000);
    const current = (): boolean => active.current && Boolean(owner) && owner === authRef.current.account?.id && epoch === authRef.current.epoch && signal === authRef.current.signal && !signal.aborted && !authRef.current.checking;
    return { owner: owner!, epoch, signal, controller, current, timedOut: () => timedOut, valid: () => current() && !controller.signal.aborted, done: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); requests.current.delete(controller); } };
  }
  async function request(path: string, task: ReturnType<typeof begin>, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await fetch(`/api/account/tokens${path}`, { method, credentials: 'same-origin', cache: 'no-store', signal: task.controller.signal, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!task.valid()) throw new DOMException('Account changed.', 'AbortError');
    if (response.status === 401) { authRef.current.expire(); throw new DOMException('Session expired.', 'AbortError'); }
    if (!response.ok) { const value = await response.json().catch(() => ({})); throw new Error(value.message || 'The access token request failed.'); }
    if (response.status === 204) return undefined;
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The access token service is unavailable.');
    const value: unknown = await response.json();
    if (!task.valid()) throw new DOMException('Account changed.', 'AbortError');
    return value;
  }
  async function load(): Promise<void> {
    if (!authRef.current.account || authRef.current.checking || authRef.current.signal.aborted) return;
    setLoading(true); setError(''); const task = begin();
    try {
      const value = await request('', task) as { tokens?: unknown[] };
      if (!Array.isArray(value?.tokens)) throw new Error('Access tokens could not be loaded.');
      const items = value.tokens.map(parseSummary);
      if (task.valid()) { setTokens(items); setListOwner({ id: task.owner, epoch: task.epoch }); }
    } catch (cause) { if (task.current()) setError(task.timedOut() ? 'Loading access tokens timed out. Try again.' : cause instanceof Error ? cause.message : 'Access tokens could not be loaded.'); }
    finally { task.done(); if (task.current()) setLoading(false); }
  }
  useEffect(() => {
    const clear = (): void => { setRevealed(null); setCopied(false); setTokens([]); setListOwner(null); setRevokeId(null); setNotice(''); setError(''); setWorking(false); setLoading(false); pending.current = false; };
    clear();
    auth.signal.addEventListener('abort', clear, { once: true });
    if (available) void load();
    return () => { auth.signal.removeEventListener('abort', clear); };
  }, [auth.account?.id, auth.epoch, auth.signal, available]);
  async function create(): Promise<void> {
    if (!available || pending.current || !label.trim() || visibleSecret) return;
    pending.current = true; setWorking(true); setError(''); setNotice(''); const task = begin();
    try {
      const value = await request('', task, 'POST', { label: label.trim(), access, expiresInDays: days }) as { token?: unknown; details?: unknown };
      const details = parseSummary(value?.details);
      if (typeof value?.token !== 'string' || value.token.length < 16 || value.token.length > 4096 || /\s/.test(value.token)) throw new Error('The new token could not be read. Refresh the list and revoke it before trying again.');
      if (!task.valid()) return;
      setTokens(previous => [details, ...previous.filter(item => item.id !== details.id)]);
      setListOwner({ id: task.owner, epoch: task.epoch });
      setRevealed({ value: value.token, details, owner: task.owner, epoch: task.epoch, signal: task.signal }); setCopied(false); setForm(false);
    } catch (cause) {
      if (task.current()) setError(task.timedOut() || (cause instanceof TypeError) ? 'Creation was not confirmed. Refresh the list before creating another token.' : cause instanceof Error ? cause.message : 'The access token could not be created.');
    } finally { task.done(); if (task.current()) { pending.current = false; setWorking(false); } }
  }
  async function copy(): Promise<void> {
    if (!visibleSecret || !available) return;
    const signal = auth.signal, epoch = auth.epoch;
    try {
      await navigator.clipboard.writeText(visibleSecret.value);
      if (active.current && !signal.aborted && signal === authRef.current.signal && epoch === authRef.current.epoch) { setCopied(true); setNotice('Token copied. Paste it into the AllMCP connection form, never into a chat.'); }
    } catch { if (active.current && !signal.aborted) setNotice('Select the token and copy it into the AllMCP connection form.'); }
  }
  async function revoke(item: TokenSummary): Promise<void> {
    if (!available || pending.current) return;
    pending.current = true; setWorking(true); setError(''); setNotice(''); const task = begin();
    try {
      await request(`/${encodeURIComponent(item.id)}`, task, 'DELETE'); if (!task.valid()) return;
      setTokens(previous => previous.filter(value => value.id !== item.id)); setRevokeId(null); setRevealed(previous => previous?.details.id === item.id ? null : previous); setNotice('Access token revoked.');
    } catch (cause) { if (task.current()) setError(task.timedOut() ? 'Revocation was not confirmed. Refresh the list and try again.' : cause instanceof Error ? cause.message : 'The access token could not be revoked.'); }
    finally { task.done(); if (task.current()) { pending.current = false; setWorking(false); } }
  }
  return <section className="integration-tokens" aria-label="Connect an assistant">
    <div className="account-section-heading"><h3>Connect an assistant</h3><button className="button" disabled={!available || working || loading || Boolean(visibleSecret)} aria-expanded={form} onClick={() => { if (!form) { setAccess('read'); setDays(30); } setForm(!form); setError(''); setNotice(''); }}><Plus size={14}/>Create access token</button></div>
    <p className="field-hint">Copy a token into your AllMCP connection form. Never paste it into a chat.</p>
    {form && <form className="token-form" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label className="field"><span>Token label</span><input ref={field} aria-label="Token label" value={label} onChange={event => setLabel(event.target.value)} maxLength={80} required autoComplete="off" disabled={working}/></label>
      <div className="field-row"><label className="field"><span>Permission</span><select aria-label="Token permission" value={access} onChange={event => setAccess(event.target.value as 'read' | 'write')} disabled={working}><option value="read">Read only</option><option value="write">Read and edit</option></select></label><label className="field"><span>Expires in</span><select aria-label="Token expiry" value={days} onChange={event => setDays(Number(event.target.value) as 7 | 30 | 90)} disabled={working}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label></div>
      <p className="field-hint">{access === 'read' ? 'Can read the analyses in your account.' : 'Can read, create, edit and delete analyses in your account.'}</p>
      <div className="token-form-actions"><button className="button" type="button" disabled={working} onClick={() => setForm(false)}>Cancel</button><button className="button primary" type="submit" disabled={!available || working || !label.trim()}>{working ? <span className="load-spinner"/> : <KeyRound size={14}/>}Create token</button></div>
    </form>}
    {visibleSecret && <div className="token-reveal"><div className="token-reveal-heading"><strong>Copy your token now</strong><button className="icon-button" aria-label="Hide access token" onClick={() => { setRevealed(null); setNotice(''); setCopied(false); }}><X size={15}/></button></div><p>Shown once. Closing this dialog removes it from view.</p><textarea ref={tokenField} aria-label="Access token shown once" readOnly value={visibleSecret.value} autoComplete="off" spellCheck={false}/><button className="button primary" onClick={() => { void copy(); }}>{copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? 'Copied' : 'Copy token'}</button></div>}
    {error && <div className="import-error" role="alert">{error}</div>}{notice && <p className="field-hint" role="status">{notice}</p>}
    <div className="token-list-heading"><span>Access tokens</span><button className="template-link" disabled={!available || loading || working} onClick={() => { void load(); }}>Refresh</button></div>
    {loading ? <p className="field-hint" role="status">Loading access tokens…</p> : !visibleTokens.length && !error ? <p className="field-hint">No access tokens.</p> : null}
    <ul className="token-list">{visibleTokens.map(item => <li key={item.id}><div><strong>{item.label}</strong><span>{item.scopes.includes('analyses:write') ? 'Read and edit' : 'Read only'} · Expires {date(item.expiresAt)}<br/>{item.lastUsedAt ? `Last used ${date(item.lastUsedAt)}` : 'Not used'}</span></div>{revokeId === item.id ? <div className="token-revoke-confirm"><span>Revoke this token?</span><button className="button danger" disabled={working || loading || !available} onClick={() => { void revoke(item); }}>Confirm revoke</button><button className="button" disabled={working} onClick={() => setRevokeId(null)}>Cancel</button></div> : <button className="button" disabled={working || loading || !available} aria-label={`Revoke ${item.label}`} onClick={() => setRevokeId(item.id)}>Revoke</button>}</li>)}</ul>
  </section>;
}
