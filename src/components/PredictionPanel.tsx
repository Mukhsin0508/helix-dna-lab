import { useEffect, useRef, useState } from 'react';
import type { AnalysisDataset } from '../../shared/analysis';
import { downloadFile } from '../analysisUtils';
import { createPendingPrediction, PENDING_KEY, predictionJSON, readPendingPrediction, validatePredictionResult, type PendingPrediction, type PredictionResult, type PredictionStatus } from '../predictionClient';

const EXAMPLE = { variantId: 'chr22:36201698:A>C', ontologyTerm: 'UBERON:0001157', cropBp: 256 };

export default function PredictionPanel({ onOpen }: { onOpen: (dataset: AnalysisDataset) => void }) {
  const [variantId, setVariant] = useState(EXAMPLE.variantId), [ontologyTerm, setTissue] = useState(EXAMPLE.ontologyTerm), [cropBp, setCrop] = useState(EXAMPLE.cropBp);
  const [configured, setConfigured] = useState<boolean | null>(null), [consent, setConsent] = useState(false), [phase, setPhase] = useState(''), [error, setError] = useState(''), [storageWarning, setStorageWarning] = useState(false);
  const [pending, setPending] = useState<PendingPrediction | null>(null), [result, setResult] = useState<PredictionResult | null>(null);
  const controller = useRef<AbortController | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null), alive = useRef(true);
  const active = phase === 'submitting' || phase === 'starting' || phase === 'running';

  function resetResult(): void {
    controller.current?.abort(); if (timer.current) clearTimeout(timer.current);
    setResult(null); setPending(null); setPhase(''); setError('');
    try { sessionStorage.removeItem(PENDING_KEY); } catch { /* A fresh run remains usable without persistence. */ }
  }

  function persist(value: PendingPrediction): void {
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(value)); } catch { setStorageWarning(true); }
  }
  async function poll(value: PendingPrediction, signal: AbortSignal): Promise<void> {
    if (!value.jobId || signal.aborted) return;
    try {
      const state = await predictionJSON<PredictionStatus>(`/api/predictions/${value.jobId}`, { signal, headers: { Authorization: `Bearer ${value.capability}` } });
      if (signal.aborted || !alive.current) return;
      if (state.jobId !== value.jobId || !['starting', 'running', 'completed', 'failed', 'expired'].includes(state.status)) throw new Error('Invalid prediction status.');
      if (state.status === 'completed') {
        const checked = await validatePredictionResult(state.result, value.input);
        if (signal.aborted || !alive.current) return;
        setResult(checked); setPhase('completed'); return;
      }
      if (state.status === 'failed' || state.status === 'expired') throw new Error(state.error?.message || 'This prediction expired or could not complete. Start a new run.');
      setPhase(state.status);
      timer.current = setTimeout(() => { void poll(value, signal); }, 2500);
    } catch (cause) { if (!signal.aborted && alive.current) { setError(cause instanceof Error ? cause.message : 'Could not read this prediction.'); setPhase('interrupted'); } }
  }
  async function submit(value: PendingPrediction): Promise<void> {
    controller.current?.abort(); if (timer.current) clearTimeout(timer.current);
    const request = new AbortController(); controller.current = request;
    setError(''); setPhase('submitting'); setResult(null); setPending(value); persist(value);
    try {
      const state = await predictionJSON<PredictionStatus>('/api/predictions', { method: 'POST', signal: request.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${value.capability}` }, body: JSON.stringify(value.input) });
      if (request.signal.aborted || !alive.current) return;
      if (!/^[a-f0-9-]{36}$/.test(state.jobId)) throw new Error('The prediction service did not return a run ID.');
      const next = { ...value, jobId: state.jobId }; setPending(next); persist(next); setPhase('starting');
      await poll(next, request.signal);
    } catch (cause) { if (!request.signal.aborted && alive.current) { setError(cause instanceof Error ? cause.message : 'The prediction could not start.'); setPhase('interrupted'); } }
  }
  useEffect(() => {
    alive.current = true;
    const request = new AbortController();
    void predictionJSON<{ configured: boolean }>('/api/predictions/health', { signal: request.signal }).then(value => { if (!request.signal.aborted) setConfigured(value.configured === true); }).catch(() => { if (!request.signal.aborted) { setConfigured(false); setError('The prediction service is unavailable. Existing analyses remain available.'); } });
    const previous = readPendingPrediction();
    if (previous) {
      setPending(previous); setVariant(previous.input.variantId); setTissue(previous.input.ontologyTerm); setCrop(previous.input.cropBp);
      if (previous.jobId) { const jobRequest = new AbortController(); controller.current = jobRequest; setPhase('running'); void poll(previous, jobRequest.signal); }
      else { setPhase('interrupted'); setError('The last submission was interrupted. Resume checks the same request without starting a duplicate.'); }
    }
    return () => { alive.current = false; request.abort(); controller.current?.abort(); if (timer.current) clearTimeout(timer.current); };
  }, []);

  return <div className="modal-body prediction-panel">
    <p>Compare a single DNA change against the human reference. Google AlphaGenome returns RNA-seq signal for your selected tissue.</p>
    <button className="template-link" disabled={active} onClick={() => { resetResult(); setVariant(EXAMPLE.variantId); setTissue(EXAMPLE.ontologyTerm); setCrop(EXAMPLE.cropBp); }}>Use Google’s chromosome 22 example</button>
    <fieldset disabled={active} className="prediction-fields">
      <label className="field"><span>Variant · GRCh38 · 1-based</span><input aria-label="Prediction variant" spellCheck={false} value={variantId} maxLength={60} onChange={event => { resetResult(); setVariant(event.target.value); }} /></label>
      <label className="field"><span>Tissue / cell ontology</span><input aria-label="Prediction tissue" spellCheck={false} value={ontologyTerm} maxLength={40} onChange={event => { resetResult(); setTissue(event.target.value); }} list="prediction-tissues"/><datalist id="prediction-tissues"><option value="UBERON:0001157">Colon · Transverse</option><option value="CL:0000679">Glutamatergic neuron</option><option value="UBERON:0001870">Frontal cortex</option></datalist></label>
      <label className="field"><span>Display window · base pairs</span><select aria-label="Prediction display window" value={cropBp} onChange={event => { resetResult(); setCrop(Number(event.target.value)); }}>{[32, 64, 128, 256, 512, 1024].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
      <p className="field-hint">Full 1 Mb context is predicted. This window selects the exact values to display; no averaging is applied.</p>
      <label className="prediction-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)}/>Send this variant and tissue to Google AlphaGenome.</label>
    </fieldset>
    {configured === null && <p role="status">Checking the connection…</p>}
    {configured === false && <div className="prediction-unavailable" role="status">Live predictions are not connected yet. The site owner must configure the AlphaGenome API key.</div>}
    {active && <p className="prediction-progress" role="status"><span className="load-spinner"/>{phase === 'starting' ? 'Starting the prediction service…' : phase === 'submitting' ? 'Submitting your variant…' : 'Waiting for Google’s prediction…'}</p>}
    {error && <div role="alert" className="import-error">{error}</div>}
    {storageWarning && <p>Keep this tab open. Browser storage is unavailable, so this run cannot be restored after closing.</p>}
    {result && <div className="prediction-complete" role="status"><strong>Prediction received</strong><span>{result.analysis.rows.length.toLocaleString()} REF/ALT pairs · source checksum verified</span></div>}
    <div className="prediction-actions">
      {result && <button className="button" onClick={resetResult}>New run</button>}
      {phase === 'interrupted' && pending && <button className="button" onClick={() => { void submit(pending); }}>Resume last run</button>}
      {result && <><button className="button" onClick={() => downloadFile(result.sourceResultJson, 'alphagenome-source-result.json', 'application/json')}>Download source</button><button className="button primary" onClick={() => onOpen(result.analysis)}>Open prediction</button></>}
      {!result && <button className="button primary" disabled={!configured || active || !consent || !/^chr(?:[1-9]|1\d|2[0-2]|X|Y):[1-9]\d*:[ACGT]>[ACGT]$/.test(variantId) || !/^(?:UBERON|CL):\d{7}$/.test(ontologyTerm)} onClick={() => { void submit(createPendingPrediction({ variantId, ontologyTerm, cropBp })); }}>Run prediction</button>}
    </div>
    <p className="field-hint">Research predictions describe molecular signals. They do not establish clinical benefit, edit safety or whole-body traits. Results remain available from the service for one hour.</p>
  </div>;
}
