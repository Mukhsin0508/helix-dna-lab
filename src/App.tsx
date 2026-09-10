import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine, ArrowUpRight, Check, ChevronDown, ChevronRight, Copy, Dna,
  Expand, ExternalLink, FlaskConical, Layers2, Link2, Menu,
  Pause, Play, Plus, RotateCcw, Search, Settings2, SplitSquareHorizontal, Trash2, X,
} from "lucide-react";
import { DEFAULT_EXPERIMENT } from "../shared/experiments";
import { SICKLE_CELL_EVIDENCE as EVIDENCE } from "../shared/outcomes";
import { workspaceToJSON, type Candidate } from "../shared/workbench";
import type { Base, ViewMode } from "../shared/types";
import MolecularScene from "./components/MolecularScene";
import OutcomeScene from "./components/OutcomeScene";
import { useWorkbench } from "./useWorkbench";
import { useLab } from "./useLab";

const BASES: Base[] = ["A", "C", "G", "T"];
const normalizeCandidate = (candidate: Candidate): Candidate => ({ ...candidate, title: candidate.title.trim(), question: candidate.question.trim() });
const STUDY = DEFAULT_EXPERIMENT;
const kindLabel = (candidate: Candidate): string => candidate.scenario === "sickle-cell" ? "Blood cell function" : "Mutation effects";
const variantState = (candidate: Candidate): "published" | "unchanged" | "unscored" => candidate.alternate === STUDY.referenceSequence[candidate.selectedIndex]
  ? "unchanged" : candidate.selectedIndex === 20 && candidate.alternate === "A" ? "published" : "unscored";
const evidenceLabel = (candidate: Candidate): string => candidate.scenario === "sickle-cell" ? "Historical trial" : variantState(candidate) === "published" ? "Published finding" : variantState(candidate) === "unchanged" ? "Unchanged sequence" : "Not assessed";

function EvidencePanel({ candidate }: { candidate: Candidate }) {
  if (candidate.scenario === "sickle-cell") return <div className="evidence-content">
    <span className="evidence-tag"><span /> Historical trial result</span>
    <div className="clinical-fraction"><strong>{EVIDENCE.responders}</strong><span>/ {EVIDENCE.evaluable}</span></div>
    <h3>Evaluable participants met the endpoint.</h3>
    <p>{EVIDENCE.endpoint}</p>
    <dl className="evidence-facts"><div><dt>Treated</dt><dd>44 participants</dd></div><div><dt>Evaluable</dt><dd>31 participants</dd></div><div><dt>Design</dt><dd>Single-arm trial</dd></div><div><dt>Reported</dt><dd>8 December 2023</dd></div></dl>
    <p className="evidence-context">31 of 44 treated participants had sufficient follow-up. This observation is not an individual success or cure probability.</p>
    <a className="source-link" href={EVIDENCE.sourceUrl} target="_blank" rel="noreferrer">Read the FDA report <ArrowUpRight size={16} /></a>
    <details className="evidence-details"><summary>Treatment context <ChevronDown size={15} /></summary><p>{EVIDENCE.limitations}</p></details>
  </div>;
  const state = variantState(candidate);
  return <div className="evidence-content">
    <span className={`evidence-tag ${state === "unscored" ? "unassessed" : ""}`}><span /> {evidenceLabel(candidate)}</span>
    {state === "published" ? <><div className="clinical-fraction"><strong>39</strong><span>RNA bases</span></div><h3>A different splice site changes the message.</h3><p>The published G → A variant retained 39 extra RNA bases, adding 13 amino acids to the protein.</p><p className="evidence-context">The study reported minigene evidence for altered splicing. The scene replays that finding; it does not run AlphaGenome.</p></>
      : state === "unchanged" ? <><h3>The sequence is unchanged.</h3><p>The alternate letter matches the reference. No mutation has been introduced.</p></>
        : <><h3>This edit has no result yet.</h3><p>Your alternative is saved as a question. No model output or experiment is available for this edit.</p></>}
    <dl className="evidence-facts"><div><dt>Gene</dt><dd>DNM1</dd></div><div><dt>Assembly</dt><dd>GRCh38</dd></div><div><dt>Position</dt><dd>{(STUDY.locus.start + candidate.selectedIndex).toLocaleString("en-US")}</dd></div><div><dt>Change</dt><dd>{STUDY.referenceSequence[candidate.selectedIndex]} → {candidate.alternate}</dd></div></dl>
    <a className="source-link" href={STUDY.sources[0].url} target="_blank" rel="noreferrer">Read the Atlas study <ArrowUpRight size={16} /></a>
    <details className="evidence-details"><summary>Reference verification <ChevronDown size={15} /></summary><p>41 bases, chromosome 9, forward strand. Independently verified against UCSC and Ensembl.</p>{STUDY.sources.slice(2).map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title} <ExternalLink size={12} /></a>)}</details>
  </div>;
}

/** The existing replay API remains the only authority for replay status. */
function MutationViewport({ workspaceId, candidate, compare, resetKey, onSelect }: { workspaceId: string; candidate: Candidate; compare: boolean; resetKey: number; onSelect: (index: number) => void }) {
  const { session, experiment, busy, error, mutate, clearError } = useLab({ replayKey: `${workspaceId}:${candidate.id}` });
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [view, setView] = useState<ViewMode>("dna");
  const [sceneError, setSceneError] = useState("");
  const [retry, setRetry] = useState(0);
  const progressRef = useRef(0);
  const restoredSession = useRef<string | undefined>(undefined);
  const sessionMatches = Boolean(session && session.selectedIndex === candidate.selectedIndex && session.alternate === candidate.alternate);
  const curated = variantState(candidate) === "published";
  const replayed = sessionMatches && curated && session?.status === "replayed";

  useEffect(() => {
    if (session && restoredSession.current !== session.id) {
      restoredSession.current = session.id;
      setView(session.view);
    }
  }, [session?.id]);
  useEffect(() => {
    setPlaying(false); setProgress(0); progressRef.current = 0;
    if (session && !sessionMatches) void mutate("patch", { selectedIndex: candidate.selectedIndex, alternate: candidate.alternate });
  }, [candidate.selectedIndex, candidate.alternate, session?.id, sessionMatches, mutate]);
  useEffect(() => {
    if (sessionMatches && session && !playing) { setProgress(session.progress); progressRef.current = session.progress; }
  }, [session?.progress, sessionMatches]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0, previous = performance.now();
    const tick = (now: number): void => {
      progressRef.current = Math.min(1, progressRef.current + Math.min(now - previous, 100) / 16000);
      previous = now; setProgress(progressRef.current);
      if (progressRef.current < 1) frame = requestAnimationFrame(tick);
      else { setPlaying(false); void mutate("patch", { progress: 1 }); }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, mutate]);
  async function replay(): Promise<void> {
    if (playing) { setPlaying(false); await mutate("patch", { progress: progressRef.current }); return; }
    if (replayed && progressRef.current > 0 && progressRef.current < 1) { setView("rna"); setPlaying(true); return; }
    const next = await mutate("run");
    if (next?.status === "replayed") { setView("rna"); setProgress(0); progressRef.current = 0; setPlaying(true); }
  }
  return <div className="mutation-view">
    <div className="mutation-stage">
      {session && experiment ? <MolecularScene key={retry} view={view} compare={compare} progress={replayed ? progress : 0}
        playing={playing} ambient={playing} selectedIndex={candidate.selectedIndex} alternate={candidate.alternate}
        sequence={experiment.referenceSequence} onSelectBase={onSelect} resetKey={resetKey}
        rnaHasEvidence={replayed} rnaIsUnchanged={variantState(candidate) === "unchanged"}
        onError={setSceneError} onReady={() => setSceneError("")} /> : <div className="scene-loading">Opening the reference sequence…</div>}
      <div className="scene-topline"><span className="scene-chip">DNM1 <span>chr9:{STUDY.locus.start + candidate.selectedIndex}</span></span>
        <div className="view-switch" aria-label="Molecular view">{(["cell", "dna", "rna"] as ViewMode[]).map(item => <button key={item} aria-pressed={view === item} onClick={() => { setView(item); setPlaying(false); if (sessionMatches) void mutate("patch", { view: item, progress: progressRef.current }); }}>{item === "cell" ? "Cell" : item.toUpperCase()}</button>)}</div></div>
      {sceneError && <div className="scene-recovery" role="status"><span>{sceneError} Editing and evidence remain available.</span><button onClick={() => setRetry(value => value + 1)}>Retry 3D</button></div>}
      <div className="scene-disclosure">Illustrative 3D · published replay only</div>
    </div>
    <div className="viewport-playbar">
      <button className="play-button" disabled={busy || !sessionMatches || !curated} onClick={() => { void replay(); }}>{playing ? <Pause size={16} /> : <Play size={16} />}<span>{playing ? "Pause replay" : replayed && progress > 0 && progress < 1 ? "Resume replay" : "Replay finding"}</span></button>
      <input aria-label="Replay progress" type="range" min="0" max="1" step="0.001" value={replayed ? progress : 0} disabled={!replayed || busy}
        onChange={event => { setPlaying(false); const next = Number(event.target.value); setProgress(next); progressRef.current = next; }}
        onPointerUp={() => { if (replayed) void mutate("patch", { progress: progressRef.current }); }}
        onKeyUp={() => { if (replayed) void mutate("patch", { progress: progressRef.current }); }} />
      <span className="time-label">{Math.round(progress * 16)} / 16s</span>
    </div>
    {error && <div className="inline-error" role="alert">{error}<button aria-label="Dismiss replay error" onClick={clearError}><X size={15} /></button></div>}
  </div>;
}

export default function App() {
  const { workspace, error, busy, saveCandidates, clearError } = useWorkbench();
  const [draft, setDraft] = useState<Candidate>();
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [tab, setTab] = useState<"evidence" | "notes">("evidence");
  const [compare, setCompare] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");
  const stageRef = useRef<HTMLDivElement>(null);
  const shareDialog = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const saved = workspace?.candidates.find(candidate => candidate.id === draft?.id);
  const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));
  useEffect(() => {
    if (draft || !workspace) return;
    const selectedId = new URLSearchParams(window.location.search).get("candidate");
    setDraft(workspace.candidates.find(candidate => candidate.id === selectedId) ?? workspace.candidates[0]);
  }, [workspace, draft]);
  useEffect(() => {
    if (!workspace || !draft) return;
    // The URL remembers selection; the server remains the source of saved candidate data.
    const url = new URL(window.location.href);
    url.searchParams.set("workspace", workspace.id);
    url.searchParams.set("candidate", draft.id);
    window.history.replaceState(window.history.state, "", url);
  }, [workspace?.id, draft?.id]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    if (shareOpen) shareDialog.current?.showModal(); else shareDialog.current?.close();
  }, [shareOpen]);
  const save = useCallback(async (): Promise<boolean> => {
    if (!workspace || !draft || busy || savingRef.current) return false;
    if (!dirty) return true;
    const original = draft;
    const normalized = normalizeCandidate(original);
    const next = workspace.candidates.map(candidate => candidate.id === original.id ? normalized : candidate);
    savingRef.current = true;
    try {
      const success = await saveCandidates(next);
      if (success) {
        // Do not overwrite a newer draft if another action updated it before the save began.
        setDraft(current => JSON.stringify(current) === JSON.stringify(original) ? normalized : current);
        setNotice("Changes saved");
      }
      return success;
    } finally { savingRef.current = false; }
  }, [workspace, draft, dirty, busy, saveCandidates]);
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void save(); }
      if (event.key === "Escape") { setCreateOpen(false); setNavOpen(false); setInspectorOpen(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save]);

  function update(patch: Partial<Candidate>): void {
    // Canvas picks are edits too; close the same in-flight save window as disabled form fields.
    if (busy || savingRef.current) return;
    setDraft(previous => previous ? { ...previous, ...patch } : previous);
  }
  async function select(candidate: Candidate): Promise<void> {
    if (busy || savingRef.current || candidate.id === draft?.id) return;
    if (dirty && !await save()) return;
    setDraft(candidate); setNavOpen(false); setResetKey(key => key + 1);
  }
  async function create(scenario: Candidate["scenario"], duplicate = false): Promise<void> {
    if (!workspace || !draft || busy || savingRef.current || workspace.candidates.length >= 20) return;
    const original = normalizeCandidate(draft);
    const candidate: Candidate = duplicate ? { ...original, id: crypto.randomUUID(), title: `${original.title.slice(0, 70)} · copy`, createdAt: new Date().toISOString() }
      : { id: crypto.randomUUID(), title: scenario === "sickle-cell" ? "Fetal hemoglobin" : "DNM1 splice variant", question: scenario === "sickle-cell" ? "Can gene therapy reduce sickle-cell crises?" : "How does one DNA change alter RNA assembly?", scenario, intervention: "intervention", selectedIndex: 20, alternate: "A", notes: "", createdAt: new Date().toISOString() };
    const normalized = normalizeCandidate(candidate);
    const next = [...workspace.candidates.map(item => item.id === original.id ? original : item), normalized];
    savingRef.current = true;
    try {
      if (await saveCandidates(next)) { setDraft(normalized); setCreateOpen(false); setNavOpen(false); setNotice(duplicate ? "Alternative duplicated" : "Comparison created"); }
    } finally { savingRef.current = false; }
  }
  async function remove(): Promise<void> {
    if (!workspace || !draft || workspace.candidates.length < 2 || busy || savingRef.current) return;
    if (!window.confirm(`Delete “${draft.title}”? This removes this saved comparison and its notes.`)) return;
    const next = workspace.candidates.filter(item => item.id !== draft.id);
    savingRef.current = true;
    try {
      if (await saveCandidates(next)) { setDraft(next[0]); setNotice("Comparison deleted"); }
    } finally { savingRef.current = false; }
  }
  function exportWorkspace(): void {
    if (!workspace) return;
    const url = URL.createObjectURL(new Blob([workspaceToJSON(workspace)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `helix-workspace-${workspace.id.slice(0, 8)}.json`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Saved comparison settings exported");
  }
  async function openShare(): Promise<void> { if (busy || savingRef.current || (dirty && !await save())) return; setShareOpen(true); }
  async function copyLink(): Promise<void> {
    if (!workspace) return;
    const url = new URL(location.origin + location.pathname); url.searchParams.set("workspace", workspace.id);
    if (draft) url.searchParams.set("candidate", draft.id);
    try { await navigator.clipboard.writeText(url.href); setCopied(true); }
    catch { setNotice("Select and copy the link below."); }
  }
  async function expand(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (stageRef.current?.requestFullscreen) await stageRef.current.requestFullscreen();
      else setNotice("Fullscreen is unavailable in this browser.");
    } catch { setNotice("Fullscreen is unavailable in this browser."); }
  }

  if (!workspace || !draft) return <main className="workspace-loading"><span className="helix-mark"><Dna size={28} /></span><h1>{error ? "Your workspace could not open" : "Opening your workspace"}</h1><p>{error || "Loading saved comparisons."}</p>{error && <button className="button primary" onClick={() => location.reload()}>Try again</button>}</main>;
  const isBlood = draft.scenario === "sickle-cell";
  const visibleCandidates = workspace.candidates.filter(candidate => `${candidate.title} ${candidate.question} ${kindLabel(candidate)}`.toLowerCase().includes(search.toLowerCase()));
  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}?workspace=${workspace.id}&candidate=${draft.id}` : "";

  return <div className="workspace-shell">
    <header className="app-header">
      <button className="icon-button mobile-menu" aria-label="Open comparisons" onClick={() => setNavOpen(!navOpen)}><Menu size={20} /></button>
      <a className="brand" href={shareUrl} aria-label="Helix workspace"><span className="helix-mark"><Dna size={24} strokeWidth={1.7} /></span>helix<span className="brand-divider" /></a>
      <span className="workspace-name">Personal workspace</span>
      <span className={`save-status ${dirty ? "pending" : ""}`} aria-live="polite">{busy ? <span className="save-spinner" /> : dirty ? <span className="unsaved-dot" /> : <Check size={14} />}{busy ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>
      <div className="header-actions"><button className="button quiet" aria-label="Export" onClick={exportWorkspace} disabled={dirty || busy} title={dirty ? "Save your changes before exporting" : "Export saved comparison settings"}><ArrowDownToLine size={16} /><span>Export</span></button><button className="button" aria-label="Share" onClick={() => { void openShare(); }} disabled={busy}><Link2 size={16} /><span>Share</span></button></div>
    </header>

    <aside className={`workspace-sidebar ${navOpen ? "is-open" : ""}`} aria-label="Saved comparisons">
      <div className="sidebar-heading"><span>Comparisons</span><button className="icon-button mobile-close" aria-label="Close comparisons" onClick={() => setNavOpen(false)}><X size={18} /></button></div>
      <div className="new-comparison-wrap"><button className="button primary new-comparison" disabled={busy || workspace.candidates.length >= 20} aria-expanded={createOpen} onClick={() => setCreateOpen(!createOpen)}><Plus size={17} /> New comparison <ChevronDown size={14} /></button>
        {createOpen && <div className="create-menu"><button onClick={() => { void create("sickle-cell"); }}><span className="case-icon blood-icon"><span /></span><span>Blood cell function<small>Gene therapy evidence</small></span></button><button onClick={() => { void create("dnm1"); }}><Dna size={19} /><span>Mutation effects<small>DNM1 published case</small></span></button></div>}
      </div>
      <label className="sidebar-search"><Search size={16} /><input aria-label="Search comparisons" placeholder="Find a comparison" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <div className="candidate-list">{visibleCandidates.map(candidate => <button key={candidate.id} className={`candidate-item ${candidate.id === draft.id ? "selected" : ""}`} disabled={busy} onClick={() => { void select(candidate); }} aria-current={candidate.id === draft.id ? "page" : undefined}>
        {candidate.scenario === "sickle-cell" ? <span className="case-icon blood-icon"><span /></span> : <Dna size={18} />}<span><strong>{candidate.id === draft.id ? draft.title || "Untitled comparison" : candidate.title}{candidate.id === draft.id && dirty && <i aria-label="unsaved" />}</strong><small>{kindLabel(candidate)}</small></span><ChevronRight className="candidate-chevron" size={14} /></button>)}{!visibleCandidates.length && <p className="empty-search">No comparisons match this search.</p>}</div>
      <button className={`review-link ${reviewOpen ? "active" : ""}`} aria-expanded={reviewOpen} onClick={() => { setReviewOpen(!reviewOpen); setNavOpen(false); }}><Layers2 size={17} /> Review alternatives <span>{workspace.candidates.length}</span></button>
      <div className="sidebar-bottom"><div className="connection-state"><span /> Live predictions not connected</div><p>Saved questions and sourced evidence. No new prediction is computed.</p><a href="/api/openapi.json" target="_blank" rel="noreferrer">API reference <ArrowUpRight size={13} /></a></div>
    </aside>

    <main className="workspace-main">
      <div className="comparison-heading"><div className="comparison-kicker"><span>{kindLabel(draft)}</span><span className="text-dot">·</span><span>{evidenceLabel(draft)}</span></div>
        <div className="title-row"><input className="comparison-title" aria-label="Comparison title" maxLength={80} value={draft.title} disabled={busy} onChange={event => update({ title: event.target.value })} /><button className="icon-button inspector-toggle" aria-label="Open evidence and setup" onClick={() => setInspectorOpen(!inspectorOpen)}><Settings2 size={21} /></button></div>
        <textarea className="question-input" aria-label="Research question" rows={2} maxLength={500} value={draft.question} disabled={busy} onChange={event => update({ question: event.target.value })} />
        <div className="comparison-toolbar"><div className="segmented-control"><button className={!compare ? "active" : ""} aria-pressed={!compare} onClick={() => setCompare(false)}><FlaskConical size={15} /> Explore</button><button className={compare ? "active" : ""} aria-pressed={compare} onClick={() => setCompare(true)}><SplitSquareHorizontal size={16} /> Compare</button></div><div className="comparison-tools"><button className="button quiet duplicate-button" aria-label="Duplicate" disabled={busy || workspace.candidates.length >= 20} onClick={() => { void create(draft.scenario, true); }}><Copy size={15} /><span>Duplicate</span></button><button className="button save-button" disabled={!dirty || busy} onClick={() => { void save(); }}><Check size={16} /><span>Save changes</span></button></div></div>
      </div>

      <div className="visual-workspace" ref={stageRef}>
        <div className="canvas-tools"><button className="icon-button" aria-label="Recenter camera" title="Recenter camera" onClick={() => setResetKey(key => key + 1)}><RotateCcw size={16} /></button><button className="icon-button" aria-label="Expand visual workspace" title="Expand" onClick={() => { void expand(); }}><Expand size={16} /></button></div>
        {isBlood ? <>
          <div className={`blood-comparison ${compare ? "split" : "single"}`}>
            {(compare ? ["baseline", draft.intervention] as const : [draft.intervention]).map((mode, index) => <section className="blood-pane" key={`${index}-${mode}`} aria-label={compare && index === 0 ? "Sickling illustration" : mode === "baseline" ? "Sickling illustration" : "Fetal hemoglobin illustration"}>
              <OutcomeScene mode={mode} playing={playing} resetKey={resetKey} />
              <div className="blood-pane-heading"><span className={`mode-dot ${mode}`} /><div><h2>{mode === "baseline" ? "Sickling" : "With fetal hemoglobin"}</h2><p>{mode === "baseline" ? "Distorted cells can obstruct flow" : "Illustrating reduced sickling"}</p></div></div>
              {mode === "intervention" && <span className="mechanism-label">HbF ↑</span>}
            </section>)}
            <div className="scene-disclosure">Illustrative 3D · not a calibrated simulation</div>
          </div>
          <div className="viewport-playbar"><button className="play-button" aria-pressed={playing} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={16} /> : <Play size={16} />}<span>{playing ? "Pause motion" : "Play motion"}</span></button><span className="orbit-hint">Drag to orbit <span>·</span> Scroll to zoom</span><span className="visual-only">Mechanism view</span></div>
        </> : <MutationViewport key={draft.id} workspaceId={workspace.id} candidate={draft} compare={compare} resetKey={resetKey} onSelect={index => update({ selectedIndex: index })} />}
      </div>

      <section className="outcome-summary" aria-label="What the evidence tells us"><span className="outcome-icon">{isBlood ? <FlaskConical size={20} /> : <Dna size={22} />}</span><div><h2>{isBlood ? "A treatment outcome, with the evidence attached." : variantState(draft) === "published" ? "A single edit. A different RNA transcript." : variantState(draft) === "unchanged" ? "No change to the reference sequence." : "A new question, waiting for evidence."}</h2><p>{isBlood ? "The two views illustrate a mechanism. They are not trial arms or a prediction of treatment response." : variantState(draft) === "published" ? "The published variant adds 39 RNA bases. Other edits remain unscored." : variantState(draft) === "unchanged" ? "Choose a different alternate to record a variant." : "Save this alternative and your notes. No outcome is inferred from the animation."}</p></div><button className="text-button" onClick={() => { setTab("evidence"); setInspectorOpen(true); }}>Evidence <ArrowUpRight size={16} /></button></section>

      {reviewOpen && <section className="alternatives-panel"><div className="panel-heading"><div><h2>Review alternatives</h2><p>Saved setups and their available evidence.</p></div><button className="icon-button" aria-label="Close alternatives review" onClick={() => setReviewOpen(false)}><X size={19} /></button></div><div className="table-scroll"><table><thead><tr><th>Comparison</th><th>Setup</th><th>Evidence</th><th>Notes</th><th /></tr></thead><tbody>{workspace.candidates.map(candidate => <tr key={candidate.id} className={candidate.id === draft.id ? "current-row" : ""}><td><strong>{candidate.title}</strong><span>{candidate.question}</span></td><td>{candidate.scenario === "sickle-cell" ? candidate.intervention === "baseline" ? "Sickling illustration" : "Fetal hemoglobin illustration" : `chr9:${STUDY.locus.start + candidate.selectedIndex} ${STUDY.referenceSequence[candidate.selectedIndex]} → ${candidate.alternate}`}</td><td><span className="table-evidence">{evidenceLabel(candidate)}</span></td><td>{candidate.notes ? `${candidate.notes.slice(0, 70)}${candidate.notes.length > 70 ? "…" : ""}` : "—"}</td><td><button className="icon-button" disabled={busy} aria-label={`Open ${candidate.title}`} onClick={() => { void select(candidate); }}><ArrowUpRight size={17} /></button></td></tr>)}</tbody></table></div></section>}
      <footer className="workspace-footer"><span>Questions are saved. Outcomes require evidence.</span><span>⌘ / Ctrl + Enter to save</span></footer>
    </main>

    <aside className={`workspace-inspector ${inspectorOpen ? "is-open" : ""}`} aria-label="Comparison setup and evidence"><div className="inspector-header"><h2>Comparison setup</h2><button className="icon-button mobile-close" aria-label="Close evidence and setup" onClick={() => setInspectorOpen(false)}><X size={18} /></button><Settings2 className="desktop-setting" size={17} /></div>
      <div className="setup-content"><label className="field-label" htmlFor="comparison-intervention">{isBlood ? "Illustrated mechanism" : "Alternate base"}</label>
        {isBlood ? <><div className="select-wrap"><select id="comparison-intervention" disabled={busy} value={draft.intervention} onChange={event => update({ intervention: event.target.value as Candidate["intervention"] })}><option value="intervention">Increased fetal hemoglobin</option><option value="baseline">Sickling baseline</option></select><ChevronDown size={15} /></div><p className="setup-caption">Casgevy · edited blood stem cells</p></> : <><div className="base-select" id="comparison-intervention" role="group" aria-label="Alternate base">{BASES.map(base => <button key={base} aria-label={`Set alternate base ${base}`} aria-pressed={draft.alternate === base} disabled={busy} className={draft.alternate === base ? "selected" : ""} onClick={() => update({ alternate: base })}>{base}</button>)}</div><div className="sequence-label"><span>Verified reference · GRCh38</span><span>41 bases</span></div><div className="reference-strip">{STUDY.referenceSequence.split("").map((base, index) => <button key={index} aria-label={`Select position ${STUDY.locus.start + index}, ${base}`} aria-pressed={draft.selectedIndex === index} disabled={busy} className={draft.selectedIndex === index ? "selected" : ""} onClick={() => update({ selectedIndex: index })}>{base}</button>)}</div><p className="setup-caption">chr9:{STUDY.locus.start + draft.selectedIndex} · {STUDY.referenceSequence[draft.selectedIndex]} → {draft.alternate}</p>{variantState(draft) !== "published" && <button className="text-button restore-edit" disabled={busy} onClick={() => update({ selectedIndex: 20, alternate: "A" })}>Load published variant <RotateCcw size={13} /></button>}</>}
      </div>
      <div className="inspector-tabs" role="tablist" aria-label="Comparison detail"><button role="tab" aria-selected={tab === "evidence"} onClick={() => setTab("evidence")}>Evidence</button><button role="tab" aria-selected={tab === "notes"} onClick={() => setTab("notes")}>Notes{draft.notes && <span className="notes-dot" />}</button></div>
      {tab === "evidence" ? <EvidencePanel candidate={draft} /> : <div className="notes-content"><label htmlFor="candidate-notes">What would you investigate next?</label><textarea id="candidate-notes" maxLength={3000} value={draft.notes} disabled={busy} onChange={event => update({ notes: event.target.value })} placeholder="Record a hypothesis, a limitation, or the next experiment…" /><div className="notes-footer"><span>{draft.notes.length} / 3000</span><button className="button" disabled={!dirty || busy} onClick={() => { void save(); }}>Save notes</button></div><p>Notes are included in the workspace export.</p></div>}
      <div className="inspector-bottom"><button className="text-button delete-button" disabled={busy || workspace.candidates.length <= 1} onClick={() => { void remove(); }}><Trash2 size={14} /> Delete comparison</button></div>
    </aside>
    {(navOpen || inspectorOpen) && <button className="mobile-scrim" aria-label="Close side panel" onClick={() => { setNavOpen(false); setInspectorOpen(false); }} />}
    {error && <div className="error-toast" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={clearError}><X size={17} /></button></div>}
    {notice && <div className="notice-toast" role="status"><Check size={16} />{notice}</div>}
    <dialog className="share-dialog" ref={shareDialog} onCancel={() => setShareOpen(false)} onClose={() => { setShareOpen(false); setCopied(false); }}><div className="dialog-heading"><h2>Share this workspace</h2><button className="icon-button" aria-label="Close sharing" onClick={() => setShareOpen(false)}><X size={20} /></button></div><p>Anyone with this link can view and edit all comparisons and notes. Only share material you are comfortable making accessible this way.</p><label htmlFor="workspace-share-link">Workspace link</label><input id="workspace-share-link" value={shareUrl} readOnly onFocus={event => event.target.select()} /><button className="button primary" onClick={() => { void copyLink(); }}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "Copied" : "Copy link"}</button></dialog>
  </div>;
}
