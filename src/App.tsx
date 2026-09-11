import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpRight, Check, ChevronDown, CircleHelp, Copy, Database, ExternalLink, FileJson, FileSpreadsheet, GitBranch, Info, Link2, Menu, PanelLeftClose, Plus, Save, Settings2, SlidersHorizontal, Table2, Upload, X, ChartNoAxesColumnIncreasing, Grid2X2, ChartNoAxesCombined } from 'lucide-react';
import type { AnalysisDataset, ScoreRow } from '../shared/analysis';
import { analysisCreateSchema, figureSettingsSchema, type FigureSettings } from '../shared/analysis-record';
import { datasetToCSV, parseDatasetJSON, parseScoreCSV, parseTrackCSV } from '../shared/analysis-import';
import { comparisonKey, csvForRows, DEFAULT_DATASET, defaultSettings, distinct, downloadFile, exportFigure, formatScore, importProvenance, inferenceSourceStatus, matchingRows, modalityLabel, PUBLISHED_PROVENANCE, rankedRows, scorerLabel, signalMetadataLabel, signalScope, signalStrand, signalUnit, trackGroups, trackLabel, unitLabel } from './analysisUtils';
import AnalysisFigure from './components/AnalysisFigure';
import { useAnalysis } from './useAnalysis';

type ImportKind = 'json' | 'scores' | 'tracks';
const CHARTS = [{ id: 'bars', label: 'Score plot', icon: ChartNoAxesColumnIncreasing }, { id: 'heatmap', label: 'Matrix', icon: Grid2X2 }, { id: 'tracks', label: 'Tracks', icon: ChartNoAxesCombined }, { id: 'table', label: 'Data', icon: Table2 }] as const;
function Modal({ title, children, footer, onClose, drawer = false }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; drawer?: boolean }) {
  const container = useRef<HTMLDivElement>(null); const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; container.current?.querySelector<HTMLElement>('button,input,textarea,select,a')?.focus();
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab') return;
      const items = [...(container.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]') || [])].filter(item => item.offsetParent !== null);
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    }; document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); previous?.focus(); }; }, []);
  return <div className={drawer ? 'drawer-backdrop' : 'modal-backdrop'} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className={drawer ? 'evidence-drawer' : 'modal'} ref={container} role="dialog" aria-modal="true" aria-label={title}>
    <div className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18}/></button></div>
    {children}{footer && <div className="modal-footer">{footer}</div>}
  </div></div>;
}
function ImportDialog({ onClose, onImport, initialKind = 'json' }: { onClose: () => void; onImport: (dataset: AnalysisDataset, settings?: FigureSettings) => void; initialKind?: ImportKind }) {
  const [kind, setKind] = useState<ImportKind>(initialKind), [text, setText] = useState(''), [filename, setFilename] = useState(''), [assembly, setAssembly] = useState(''), [label, setLabel] = useState(''), [sourceUrl, setSourceUrl] = useState(''), [error, setError] = useState('');
  async function readFile(file?: File): Promise<void> { if (!file) return; if (file.size > 2 * 1024 * 1024) { setError('Choose a file smaller than 2 MB.'); return; } setText(await file.text()); setFilename(file.name); if (/\.json$/i.test(file.name)) setKind('json'); setError(''); }
  function template(): void {
    const value = kind === 'json' ? JSON.stringify({ ...DEFAULT_DATASET, title: 'Published example · four ATAC scores', rows: DEFAULT_DATASET.rows.filter(row => row.modality === 'ATAC') }, null, 2)
      : kind === 'scores' ? datasetToCSV({ ...DEFAULT_DATASET, rows: DEFAULT_DATASET.rows.filter(row => row.modality === 'ATAC') }) : 'chromosome,position,reference,alternate,track\n';
    downloadFile(value, kind === 'json' ? 'helix-dataset-example.json' : kind === 'scores' ? 'published-atac-example.csv' : 'reference-alternate-template.csv', kind === 'json' ? 'application/json' : 'text/csv');
  }
  function submit(): void {
    try {
      let dataset: AnalysisDataset, settings: FigureSettings | undefined;
      if (kind === 'json') {
        if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) throw new Error('Import exceeds the 2 MB limit.');
        const parsed = JSON.parse(text);
        if (parsed?.dataset) { const input = analysisCreateSchema.parse({ dataset: parsed.dataset, settings: parsed.settings }); dataset = input.dataset; settings = input.settings; }
        else dataset = parseDatasetJSON(text);
      } else {
        const provenance = importProvenance(assembly.trim(), sourceUrl.trim(), label.trim());
        dataset = kind === 'scores' ? parseScoreCSV(text, provenance, filename || 'Imported molecular scores') : parseTrackCSV(text, provenance, filename || 'Imported signal tracks');
      }
      onImport(dataset, settings); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the dataset format.'); }
  }
  return <Modal title="Import analysis data" onClose={onClose} footer={<><button className="template-link" onClick={template}><ArrowDownToLine size={13}/>{kind === 'tracks' ? 'Download CSV headers' : 'Download real example'}</button><button className="button primary" onClick={submit} disabled={!text.trim()}>Open dataset <ArrowUpRight size={14}/></button></>}>
    <div className="modal-body"><p>Bring molecular scores or aligned reference and alternate signals. Up to 5,000 rows · 2 MB.</p>
      <div className="import-types" aria-label="Import format">{([['json','Analysis JSON'],['scores','Score CSV'],['tracks','Track CSV']] as const).map(([value,title]) => <button key={value} className={kind === value ? 'active' : ''} onClick={() => { setKind(value); setError(''); }}>{value === 'json' ? <FileJson size={14}/> : <FileSpreadsheet size={14}/>} {title}</button>)}</div>
      <label className="upload-target"><Upload size={17}/>{filename || 'Choose a CSV or JSON file'}<input type="file" accept=".csv,.json,text/csv,application/json" onChange={event => { void readFile(event.target.files?.[0]); }}/></label>
      <label className="field"><span>Or paste data</span><textarea spellCheck={false} aria-label="Paste analysis data" value={text} onChange={event => setText(event.target.value)} onPaste={event => {
        const pasted = event.clipboardData.getData('text');
        const element = event.currentTarget;
        const next = text.slice(0, element.selectionStart) + pasted + text.slice(element.selectionEnd);
        event.preventDefault();
        if (new TextEncoder().encode(next).byteLength > 2 * 1024 * 1024) { setError('Paste exceeds the 2 MB limit.'); return; }
        setText(next); setError('');
      }} placeholder={kind === 'json' ? '{ "schemaVersion": 1, "kind": "scores", … }' : kind === 'scores' ? 'variant,biosample,modality,scorer,score\n…' : 'chromosome,position,reference,alternate,track\n…'}/></label>
      {kind !== 'json' && <><div className="field-row"><label className="field"><span>Reference assembly · required</span><select value={assembly} onChange={event => setAssembly(event.target.value)}><option value="">Select assembly</option><option value="GRCh38">GRCh38 / hg38</option><option value="GRCh37">GRCh37 / hg19</option></select></label><label className="field"><span>Source label</span><input value={label} onChange={event => setLabel(event.target.value)} placeholder="Study, experiment or model" maxLength={200}/></label></div><label className="field"><span>Source URL · optional</span><input value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} placeholder="https://…" type="url" maxLength={2048}/></label><p className="field-hint">{kind === 'tracks' ? 'Positions are 0-based. Reference and alternate columns contain numeric signal, not DNA letters. One row per chromosome, position and track.' : 'Variant positions are 1-based. Raw scores retain their supplied method and units. Blank scores are rejected.'}</p></>}
      {error && <div className="import-error" role="alert">{error}</div>}
    </div>
  </Modal>;
}
function DataTable({ rows, limit = 100 }: { rows: ScoreRow[]; limit?: number }) {
  return <div className="table-scroll"><table className="data-table"><thead><tr><th>Variant · 1-based</th><th>Gene</th><th>Biosample</th><th>Raw score</th><th>Quantile</th><th>Track</th><th>Source row</th></tr></thead><tbody>{rows.slice(0, limit).map((row, index) => <tr key={`${row.variant}:${row.sourceRowIndex ?? index}:${row.geneId || ''}`}><td>{row.variant}</td><td>{row.gene || row.geneId || '—'}</td><td>{row.biosample}</td><td title={String(row.score)}>{formatScore(row.score, 7)}</td><td title={String(row.quantile ?? '')}>{formatScore(row.quantile, 6)}</td><td title={row.track}>{row.track || row.biosample}</td><td>{row.sourceRowIndex ?? '—'}</td></tr>)}</tbody></table></div>;
}
function EvidenceDrawer({ dataset, settings, onClose }: { dataset: AnalysisDataset; settings: FigureSettings; onClose: () => void }) {
  const provenance = dataset.provenance, rows = matchingRows(dataset, settings);
  const selectedTracks = dataset.kind === 'tracks' ? trackGroups(dataset.rows, dataset.trackMetadata).filter(group => !settings.track || group.key === settings.track) : [];
  const inference = provenance.inference;
  const isPublished = dataset.id === DEFAULT_DATASET.id && provenance.sourceUrl === DEFAULT_DATASET.provenance.sourceUrl;
  return <Modal title="Source & method" onClose={onClose} drawer>
    <div className="evidence-section"><h3>{provenance.sourceLabel}</h3><p>{provenance.context}</p>{provenance.sourceUrl && <a href={provenance.sourceUrl} target="_blank" rel="noreferrer">Open the original source <ArrowUpRight size={12}/></a>}</div>
    <div className="evidence-section"><h3>Dataset</h3><dl><div><dt>Assembly</dt><dd>{provenance.assembly}</dd></div><div><dt>Model</dt><dd>{provenance.model}</dd></div><div><dt>Data type</dt><dd>{dataset.kind === 'scores' ? 'Variant-effect scores' : 'Reference / alternate signals'}</dd></div><div><dt>Records</dt><dd>{dataset.rows.length.toLocaleString('en-US')}</dd></div><div><dt>Recorded</dt><dd>{provenance.recordedAt ? new Date(provenance.recordedAt).toLocaleDateString('en-GB', { day:'numeric',month:'long',year:'numeric' }) : 'Not supplied'}</dd></div><div><dt>Source status</dt><dd>{provenance.mode === 'published-example' ? 'Published example' : 'User import'}</dd></div></dl></div>
    <div className="evidence-section"><h3>Figure method</h3><p>{dataset.kind === 'scores' ? 'Scores are filtered to one modality, exact scorer, track, strand and unit. Rows are ranked by absolute magnitude. Values are not combined across incompatible assays.' : 'Supplied reference and alternate values share an axis within each chromosome and track. Declared bins are constant over [start, end); gaps remain empty. Tracks without bin metadata show supplied points only.'}</p>{dataset.kind === 'scores' && <><dl><div><dt>Scorer</dt><dd>{settings.scorer}</dd></div><div><dt>Units</dt><dd>{unitLabel(rows, settings)}</dd></div><div><dt>Display limit</dt><dd>{settings.limit} rows or features</dd></div><div><dt>Matching rows</dt><dd>{rows.length}</dd></div></dl><p>Quantile scores describe relative molecular effects. They are not AVI scores, disease probabilities or treatment success rates.</p></>}</div>
    {selectedTracks.map(group => <div className="evidence-section" key={group.key}><h3>{group.label}</h3><dl>
      <div><dt>Output type</dt><dd>{group.metadata?.outputType || 'Not provided'}</dd></div><div><dt>Units</dt><dd>{signalUnit(group.metadata)}</dd></div><div><dt>Strand</dt><dd>{signalStrand(group.metadata)}</dd></div><div><dt>Scope</dt><dd>{signalScope(group.metadata)}</dd></div><div><dt>Biosample ID</dt><dd>{group.metadata?.biosampleId || 'Not provided'}</dd></div><div><dt>Bin size</dt><dd>{group.metadata ? `${group.metadata.binSize} bp · 0-based, half-open` : 'Unspecified · supplied points only'}</dd></div>{group.metadata?.sourceName && <div><dt>Original name</dt><dd>{group.metadata.sourceName}</dd></div>}{group.metadata?.sourceIndex !== undefined && <div><dt>Source index</dt><dd>{group.metadata.sourceIndex}</dd></div>}
    </dl></div>)}
    {inference && <div className="evidence-section"><h3>Source-reported inference</h3><p>Imported identifiers describe the source execution. This workspace does not run inference or independently verify that execution.</p><dl>
      <div><dt>Variant · 1-based</dt><dd>{inference.variant}</dd></div><div><dt>Model revision</dt><dd>{inference.modelRevision}</dd></div><div><dt>Client revision</dt><dd>{inference.clientRevision}</dd></div><div><dt>Checkpoint</dt><dd>{inference.checkpointRevision}</dd></div><div><dt>Reference version</dt><dd>{inference.referenceVersion}</dd></div>
      <div><dt>Input interval</dt><dd>{`${inference.inputInterval.chromosome}:[${inference.inputInterval.start}, ${inference.inputInterval.end})`}</dd></div><div><dt>Display interval</dt><dd>{`${inference.displayInterval.chromosome}:[${inference.displayInterval.start}, ${inference.displayInterval.end})`}</dd></div>
    </dl><p>Intervals use 0-based, half-open coordinates.</p><div className="provenance-hash">Reference file SHA-256<br/>{inference.referenceSha256 || 'Not provided'}</div>{inference.inputSequenceSha256 && <div className="provenance-hash">Input sequence SHA-256<br/>{inference.inputSequenceSha256}</div>}<h3>Reported transformations</h3>{inference.transformations.length ? <ul>{inference.transformations.map((transformation, index) => <li key={index}>{transformation}</li>)}</ul> : <p>None reported.</p>}</div>}
    {provenance.artifact && <div className="evidence-section"><h3>Imported source artifact</h3><p>{provenance.artifact.filename}</p><div className="provenance-hash">Source-reported SHA-256<br/>{provenance.artifact.sha256}</div><p>This identifier records the source artifact; it does not verify model execution.</p></div>}
    {isPublished && <div className="evidence-section"><h3>Published example limits</h3><ul>{PUBLISHED_PROVENANCE.limitations.map(item => <li key={item}>{item}</li>)}</ul><p>Notebook execution timestamp is embedded source metadata, not an independently verified publication date.</p><div className="provenance-hash">Normalized source SHA-256<br/>{PUBLISHED_PROVENANCE.ui_fixture_sha256}</div></div>}
    <div className="evidence-section"><h3>Reproducibility</h3><p>The analysis JSON contains the complete dataset, source metadata and figure settings. CSV preserves numeric values; it does not contain the full provenance record.</p><a href="https://www.alphagenomedocs.com/variant_scoring.html" target="_blank" rel="noreferrer">AlphaGenome scoring documentation <ArrowUpRight size={12}/></a></div>
  </Modal>;
}
export default function App() {
  const lab = useAnalysis();
  const { dataset, settings, setSettings } = lab;
  const [importKind, setImportKind] = useState<ImportKind | null>(null), [evidence, setEvidence] = useState(false), [controls, setControls] = useState(false), [exportOpen, setExportOpen] = useState(false), [shareUrl, setShareUrl] = useState(''), [message, setMessage] = useState(''), [selected, setSelected] = useState<ScoreRow | null>(null), [copied, setCopied] = useState(false);
  const svg = useRef<SVGSVGElement>(null), exportContainer = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => rankedRows(dataset, settings), [dataset, settings]);
  const allScores = dataset.kind === 'scores' ? dataset.rows : [];
  const modalities = distinct(allScores.map(row => row.modality));
  const modalityRows = allScores.filter(row => row.modality === settings.modality);
  const scorers = distinct(modalityRows.map(row => row.scorer));
  const scorerRows = modalityRows.filter(row => row.scorer === settings.scorer);
  const groups = [...new Map(scorerRows.map(row => [comparisonKey(row), row])).entries()];
  const groupRows = scorerRows.filter(row => comparisonKey(row) === settings.track);
  const genes = distinct(groupRows.map(row => row.gene || row.geneId || '').filter(Boolean));
  const variants = distinct(groupRows.map(row => row.variant));
  const visibleCount = Math.min(settings.limit, rows.length);
  const isTracks = dataset.kind === 'tracks';
  const selectedTrackRows = dataset.kind === 'tracks' ? dataset.rows.filter(row => !settings.track || JSON.stringify([row.chromosome, row.track]) === settings.track) : [];
  const selectedTrackGroups = dataset.kind === 'tracks' ? trackGroups(selectedTrackRows, dataset.trackMetadata) : [];
  const selectedTrackMetadata = selectedTrackGroups.flatMap(group => group.metadata ? [group.metadata] : []);
  useEffect(() => { setSelected(null); }, [dataset, settings]);
  useEffect(() => { if (!exportOpen) return; const handler = (event: MouseEvent): void => { if (!exportContainer.current?.contains(event.target as Node)) setExportOpen(false); }; document.addEventListener('mousedown', handler); return () => document.removeEventListener('mousedown', handler); }, [exportOpen]);
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 5500); return () => clearTimeout(timer); }, [message]);
  function updateMethod(modality: string, scorer?: string): void {
    const first = allScores.find(row => row.modality === modality && (!scorer || row.scorer === scorer)); if (!first) return;
    setSettings({ modality, scorer: first.scorer, track: comparisonKey(first), gene: '', variant: '' });
  }
  async function handleExport(kind: 'svg' | 'png' | 'csv' | 'json'): Promise<void> {
    setExportOpen(false);
    try {
      if (kind === 'json') {
        const input = analysisCreateSchema.parse({ dataset, settings });
        downloadFile(JSON.stringify({ format: 'helix-analysis', formatVersion: 1, exportedAt: new Date().toISOString(), savedAnalysis: lab.record ? { id: lab.record.id, revision: lab.record.revision } : null, hasUnsavedChanges: lab.dirty, ...input, methods: { inferencePerformed: false, inferenceMetadata: 'source-reported; not independently verified', ranking: 'absolute magnitude within exact scorer/track/unit', missingValues: 'not filled with zero', trackRendering: 'Declared half-open bins use constant segments; missing bins are not connected. Undeclared bins render as points.' } }, null, 2), 'helix-analysis.json', 'application/json');
      } else if (kind === 'csv') downloadFile(dataset.kind === 'tracks' ? datasetToCSV({ ...dataset, rows: selectedTrackRows, trackMetadata: selectedTrackMetadata.length ? selectedTrackMetadata : undefined }) : csvForRows(rows), 'helix-selected-data.csv', 'text/csv;charset=utf-8');
      else { if (!svg.current) throw new Error('Choose Score plot, Matrix or Tracks before exporting an image.'); await exportFigure(svg.current, kind, 'helix-figure', { title: settings.title, source: dataset.provenance.sourceLabel, sourceUrl: dataset.provenance.sourceUrl, assembly: dataset.provenance.assembly, status: inferenceSourceStatus(dataset.provenance), provenance: dataset.provenance, settings, tracks: isTracks ? selectedTrackGroups.slice(0, settings.limit).map(group => ({ chromosome: group.rows[0].chromosome, track: group.rows[0].track, metadata: group.metadata || null })) : undefined }); }
      setMessage(`${kind.toUpperCase()} exported`);
    } catch (cause) { lab.setError(cause instanceof Error ? cause.message : 'Export failed.'); }
  }
  async function save(): Promise<void> { const result = await lab.save(); if (result) setMessage('Analysis saved'); }
  async function share(): Promise<void> { const record = lab.dirty ? await lab.save() : lab.record; if (!record) return; const url = new URL(location.href); url.search = ''; url.searchParams.set('analysis', record.id); setShareUrl(url.toString()); setCopied(false); }
  async function copyShare(): Promise<void> { try { await navigator.clipboard.writeText(shareUrl); setCopied(true); } catch { setMessage('Select and copy the link above.'); } }
  const sourceDate = dataset.provenance.recordedAt ? new Date(dataset.provenance.recordedAt).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : 'Date not supplied';
  return <div className="lab-app">
    <header className="appbar"><div className="wordmark"><span className="wordmark-symbol" aria-hidden="true"><i/><i/><i/></span>helix</div><span className="app-context">Analysis workspace</span><div className="appbar-right"><span className="connection-label"><i/>{dataset.provenance.mode === 'published-example' ? 'Published model output' : 'Imported data'}</span><span className={`save-state ${lab.dirty ? 'dirty' : ''}`}>{lab.busy ? 'Saving…' : lab.dirty ? 'Local draft' : 'Saved'}</span><button className="button dark" aria-label="Share analysis" onClick={() => { void share(); }} disabled={lab.busy || !lab.ready}><Link2 size={14}/><span className="save-word">Share</span></button><button className="button primary" aria-label="Save analysis" onClick={() => { void save(); }} disabled={lab.busy || !lab.ready || Boolean(lab.conflict)}>{lab.busy ? <span className="load-spinner"/> : <Save size={14}/>}<span className="save-word">Save analysis</span></button></div></header>
    {(lab.error || message) && <div className={`notice ${lab.error ? 'error' : ''}`} role={lab.error ? 'alert' : 'status'}><Info size={15}/><span>{lab.error || message}</span>{lab.conflict && <><button onClick={() => { void lab.save(true).then(record => { if (record) setMessage('Saved as a new analysis'); }); }}>Save a copy</button><button onClick={lab.loadShared}>Load shared version</button></>}<button aria-label="Dismiss message" onClick={() => { lab.clearError(); setMessage(''); }}><X size={14}/></button></div>}
    <div className="workspace-shell">
      {controls && <button className="controls-overlay" aria-label="Close controls overlay" onClick={() => setControls(false)}/>}
      <aside className={`controls-rail ${controls ? 'open' : ''}`} aria-label="Figure controls">
        <div className="rail-top"><button className="icon-button rail-close" aria-label="Close figure controls panel" onClick={() => setControls(false)}><X size={17}/></button><span className="eyebrow">Dataset</span><div className="dataset-name"><Database size={17}/><div><strong>{dataset.title}</strong><small>{dataset.rows.length.toLocaleString('en-US')} records · {dataset.provenance.assembly}</small></div></div><span className="dataset-pill"><i/>{dataset.provenance.mode === 'published-example' ? `Published example · ${sourceDate}` : 'Imported · source supplied'}</span></div>
        <div className="rail-section"><div className="rail-section-title"><h2>Analysis scope</h2><SlidersHorizontal size={13} color="#8b9ab0"/></div>
          {!isTracks ? <>
            <label className="field"><span>Modality</span><select aria-label="Modality" value={settings.modality} onChange={event => updateMethod(event.target.value)}>{modalities.map(modality => <option key={modality} value={modality}>{modalityLabel(modality)}</option>)}</select></label>
            <label className="field"><span>Scoring method</span><select aria-label="Scoring method" value={settings.scorer} title={settings.scorer} onChange={event => updateMethod(settings.modality, event.target.value)}>{scorers.map(scorer => <option key={scorer} value={scorer}>{scorerLabel(scorer)}</option>)}</select></label>
            <label className="field"><span>Track / assay</span><select aria-label="Track or assay" value={settings.track} onChange={event => setSettings({ track: event.target.value, gene: '', variant: '' })}>{groups.map(([key, row]) => <option key={key} value={key}>{trackLabel(row)}</option>)}</select></label>
            <label className="field"><span>Gene</span><select aria-label="Gene" value={settings.gene} onChange={event => setSettings({ gene: event.target.value })} disabled={!genes.length}><option value="">{genes.length ? `All ${genes.length} genes` : 'No gene-specific scores'}</option>{genes.map(gene => <option key={gene}>{gene}</option>)}</select></label>
            <label className="field"><span>Variant</span><select aria-label="Variant" value={settings.variant} onChange={event => setSettings({ variant: event.target.value })}><option value="">All {variants.length} variants</option>{variants.map(variant => <option key={variant}>{variant}</option>)}</select></label>
          </> : <><label className="field"><span>Chromosome / track</span><select value={settings.track} aria-label="Chromosome and track" onChange={event => setSettings({ track: event.target.value })}><option value="">All tracks · separate axes</option>{trackGroups(dataset.rows).map(group => <option key={group.key} value={group.key}>{group.label}</option>)}</select></label><p className="field-hint">{selectedTrackGroups.length === 1 ? `${signalUnit(selectedTrackGroups[0].metadata)} · ${signalMetadataLabel(selectedTrackGroups[0].metadata)}` : "Reference and alternate signals share each track's y-axis. Chromosomes remain separate."}</p></>}
        </div>
        <div className="rail-section"><div className="rail-section-title"><h2>Figure</h2><Settings2 size={13} color="#8b9ab0"/></div>
          {!isTracks && <label className="field"><span>Metric</span><select value={settings.metric} aria-label="Metric" onChange={event => setSettings({ metric: event.target.value as FigureSettings['metric'] })}><option value="score">Raw effect score</option><option value="quantile" disabled={!groupRows.some(row => row.quantile !== undefined)}>Quantile score</option></select></label>}
          <label className="field"><span>{isTracks && settings.chart !== 'table' ? 'Maximum tracks' : settings.chart === 'heatmap' ? 'Maximum features' : 'Maximum rows'}</span><select value={settings.limit} aria-label="Maximum displayed rows" onChange={event => setSettings({ limit: Number(event.target.value) })}>{[4, 8, 12, 24, 50, 100].map(value => <option value={value} key={value}>{value}</option>)}</select></label>
          <p className="field-hint">{isTracks ? 'Numeric signal at supplied positions.' : 'Ranked by absolute magnitude. One method and unit per figure.'}</p>
        </div>
        <div className="rail-footer"><button className="button" onClick={() => setImportKind('json')} disabled={lab.busy || !lab.ready}><Plus size={14}/>Import data</button><button className="button subtle" disabled={lab.busy || !lab.ready} onClick={() => { lab.openDataset(DEFAULT_DATASET); setControls(false); }}>Open published example</button><a className="help-link" href="https://www.alphagenomedocs.com/colabs/batch_variant_scoring.html" target="_blank" rel="noreferrer">AlphaGenome documentation <ArrowUpRight size={12}/></a></div>
      </aside>
      <main className="work-area"><div className="work-toolbar"><button className="icon-button mobile-control-toggle" aria-label={controls ? 'Close figure controls' : 'Open figure controls'} onClick={() => setControls(!controls)}>{controls ? <PanelLeftClose size={17}/> : <SlidersHorizontal size={17}/>}</button><nav className="figure-tabs" aria-label="Figure type">{CHARTS.map(chart => <button data-chart={chart.id} key={chart.id} className={settings.chart === chart.id ? 'active' : ''} aria-pressed={settings.chart === chart.id} onClick={() => { if (isTracks && chart.id !== 'tracks' && chart.id !== 'table') { setMessage('This dataset contains signal tracks. Import variant scores for Score plot or Matrix.'); return; } setSettings({ chart: chart.id }); }}>{<chart.icon size={14}/>} {chart.label}</button>)}</nav><div className="toolbar-actions"><button className="button" onClick={() => setEvidence(true)}><Info size={13}/><span>Source</span></button><div className="export-menu" ref={exportContainer}><button className="button" aria-expanded={exportOpen} onClick={() => setExportOpen(!exportOpen)}><ArrowDownToLine size={13}/>Export <ChevronDown size={11}/></button>{exportOpen && <div className="export-menu-items">{([['svg','Vector figure','SVG'],['png','High-resolution figure','PNG'],['csv','Selected data','CSV'],['json','Complete analysis','JSON']] as const).map(([value, label, extension]) => <button key={value} onClick={() => { void handleExport(value); }}>{label}<small>{extension}</small></button>)}</div>}</div></div></div>
        <div className="canvas-well"><section className="figure-sheet" aria-label="Analysis figure"><div className="sheet-heading"><div className="sheet-title-wrap"><p className="sheet-kicker"><i/>{isTracks ? 'Reference / alternate comparison' : settings.modality.replaceAll('_',' ')} · {isTracks ? 'Genomic signals' : groupRows[0]?.biosample || 'Selected data'}</p><input className="figure-title" aria-label="Figure title" maxLength={160} value={settings.title} onChange={event => setSettings({ title: event.target.value })}/><p className="figure-subtitle">{isTracks ? `${selectedTrackRows.length} supplied positions · ${dataset.provenance.assembly}${selectedTrackGroups.length === 1 ? ` · ${signalUnit(selectedTrackGroups[0].metadata)}` : ''}` : `${settings.chart === 'heatmap' ? 'Variant × feature matrix' : scorerLabel(settings.scorer)} · ${groupRows[0]?.assay || groupRows[0]?.track || 'Supplied scores'} · ${dataset.provenance.assembly}`}</p></div><span className="sheet-figure-label">FIG. 01</span></div>
          <div className="plot-host">{settings.chart === 'tracks' && !isTracks ? <div className="empty-state track-import-empty"><ChartNoAxesCombined size={28}/><h3>Bring the full genomic signal</h3><p>This example contains summary scores. Import reference and alternate signal tracks to compare the curves at each genomic position.</p><button className="button primary" onClick={() => setImportKind('tracks')}><Upload size={14}/>Import signal tracks</button></div>
            : settings.chart === 'table' ? isTracks ? <div className="chart-table"><div className="table-scroll"><table className="data-table"><thead><tr><th>Chromosome</th><th>Position · 0-based</th><th>Reference signal</th><th>Alternate signal</th><th>Track</th></tr></thead><tbody>{selectedTrackRows.slice(0, settings.limit).map(row => <tr key={`${row.chromosome}:${row.position}:${row.track}`}><td>{row.chromosome}</td><td>{row.position}</td><td>{row.reference}</td><td>{row.alternate}</td><td>{row.track}</td></tr>)}</tbody></table></div></div> : <div className="chart-table"><DataTable rows={rows} limit={settings.limit}/></div>
              : <AnalysisFigure dataset={dataset} settings={settings} svgRef={svg} onSelect={setSelected}/>}
          </div>
          {settings.chart !== 'table' && (settings.chart !== 'tracks' || isTracks) && <div className="plot-legend">{isTracks ? <><span><i className="legend-line"/>Reference signal</span><span><i className="legend-line alt"/>Alternate signal</span></> : <><span><i className="legend-line"/>Negative score</span><span><i className="legend-line alt"/>Positive score</span>{settings.chart === 'heatmap' && <span><i className="legend-empty"/>No supplied value</span>}</>}<span>{isTracks ? 'Declared bins · unspecified bins shown as points' : 'Molecular model output'}</span></div>}
          {selected && <div className="selection-strip"><strong>{selected.variant}</strong><span>{selected.gene || selected.biosample}</span><span>Raw {selected.score}</span>{selected.quantile !== undefined && <span>Quantile {formatScore(selected.quantile, 7)}</span>}<button className="icon-button" aria-label="Clear selected result" onClick={() => setSelected(null)}><X size={12}/></button></div>}
          <div className="sheet-caption"><p><strong>{dataset.provenance.sourceLabel}</strong><br/>{dataset.provenance.mode === 'published-example' ? `Published notebook snapshot · ${sourceDate} · no live inference performed.` : `${inferenceSourceStatus(dataset.provenance)}.`}</p><button className="source-action" onClick={() => setEvidence(true)}>Source & method <ArrowUpRight size={12}/></button></div>
        </section>
        <div className="figure-meta"><span><GitBranch size={12}/>{isTracks ? `${trackGroups(selectedTrackRows).length} independent chromosome / track groups` : settings.chart === 'heatmap' ? `${rows.length} matching source rows · missing values left empty` : `${visibleCount} of ${rows.length} matching rows · sorted by absolute magnitude`}</span><span className="mono">{isTracks ? 'COORDINATES: 0-BASED' : 'SCORES ≠ PROBABILITIES'}</span></div>
        {!isTracks && settings.chart !== 'table' && rows.length > 0 && <section className="data-preview" aria-label="Selected source data"><div className="data-preview-header"><strong>Underlying data <span style={{ color:'#a0acbd',marginLeft:7 }}>{rows.length} rows</span></strong><button onClick={() => setSettings({ chart:'table' })}>Open table <ArrowUpRight size={10}/></button></div><DataTable rows={rows} limit={4}/></section>}
      </div></main>
    </div>
    {importKind && <ImportDialog initialKind={importKind} onClose={() => setImportKind(null)} onImport={(value, importedSettings) => { lab.openDataset(value, importedSettings); setControls(false); setMessage(`${value.rows.length} records imported`); }}/>}
    {evidence && <EvidenceDrawer dataset={dataset} settings={settings} onClose={() => setEvidence(false)}/>}
    {shareUrl && <Modal title="Share analysis" onClose={() => setShareUrl('')} footer={<><span className="sharing-note">Source data and figure settings included.</span><button className="button primary" onClick={() => { void copyShare(); }}>{copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? 'Copied' : 'Copy link'}</button></>}><div className="modal-body"><p>Anyone with this link can view and edit this analysis. Share only data you intend to make accessible.</p><div className="share-url">{shareUrl}</div></div></Modal>}
  </div>;
}
