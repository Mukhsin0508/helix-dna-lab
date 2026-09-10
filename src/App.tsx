import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, Check, ChevronRight, Dna,
  Expand, ExternalLink, FlaskConical, Link2, Pause, Play, RotateCcw,
  Settings2, Sparkles, SplitSquareHorizontal, X,
} from "lucide-react";
import type { Base, ViewMode } from "../shared/types";
import MolecularScene from "./components/MolecularScene";
import { useLab } from "./useLab";

const BASES: Base[] = ["A", "C", "G", "T"];
const VIEWS: { key: ViewMode; label: string; number: string }[] = [
  { key: "cell", label: "Cell", number: "01" },
  { key: "dna", label: "DNA", number: "02" },
  { key: "rna", label: "RNA", number: "03" },
];
type Drawer = "edit" | "evidence" | "concept" | null;

export default function App() {
  const { session, experiment, error, busy, connected, mutate, clearError } = useLab();
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [playing, setPlaying] = useState(false);
  const [ambient, setAmbient] = useState(true);
  const [progress, setProgress] = useState(0);
  const [resetKey, setResetKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [ready, setReady] = useState(false);
  const [sceneError, setSceneError] = useState("");
  const [sceneAttempt, setSceneAttempt] = useState(0);
  const [conceptError, setConceptError] = useState(false);
  const progressRef = useRef(0);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const enteredSession = useRef<string | null>(null);

  // New sessions enter through the cell; restoring a session never resets an edit.
  const isNewSession = Boolean(session && experiment && session.revision === 0
    && session.view === "dna" && session.status === "ready" && session.progress === 0
    && session.selectedIndex === experiment.defaultIndex && session.alternate === experiment.alternate);
  const view: ViewMode = isNewSession ? "cell" : session?.view ?? "cell";

  useEffect(() => {
    if (!session || !experiment || enteredSession.current === session.id) return;
    enteredSession.current = session.id;
    if (isNewSession) void mutate("patch", { view: "cell" });
  }, [session?.id, experiment, isNewSession, mutate]);

  useEffect(() => {
    if (session && (!playing || session.status !== "replayed")) {
      setProgress(session.progress);
      progressRef.current = session.progress;
    }
  }, [session]);
  useEffect(() => { setPlaying(false); }, [session?.selectedIndex, session?.alternate]);
  useEffect(() => {
    const target = selectedRef.current;
    const strip = target?.parentElement;
    if (target && strip) strip.scrollTo({
      left: target.offsetLeft - strip.offsetLeft - (strip.clientWidth - target.clientWidth) / 2,
      behavior: "smooth",
    });
  }, [session?.selectedIndex, drawer]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
      const elapsed = Math.min(now - previous, 100);
      previous = now;
      progressRef.current = Math.min(1, progressRef.current + elapsed / 16000);
      setProgress(progressRef.current);
      if (progressRef.current < 1) frame = requestAnimationFrame(tick);
      else {
        void mutate("patch", { progress: 1 });
        setPlaying(false);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, mutate]);

  useEffect(() => {
    if (!drawer) return;
    drawerTrigger.current = document.activeElement as HTMLElement;
    drawerRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const handler = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDrawer(null);
      if (event.key !== "Tab") return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled])",
      );
      if (!focusable?.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      drawerTrigger.current?.focus();
    };
  }, [drawer]);

  async function change(patch: Parameters<typeof mutate>[1]): Promise<void> {
    setPlaying(false);
    if (patch?.view) setAmbient(true);
    await mutate("patch", { ...(playing ? { progress: progressRef.current } : {}), ...patch });
  }

  async function replay(): Promise<void> {
    if (playing) {
      setPlaying(false); setAmbient(false);
      await mutate("patch", { progress: progressRef.current });
      return;
    }
    if (session?.status === "replayed" && progressRef.current > 0 && progressRef.current < 1) {
      const prepared = await mutate("patch", { view: "rna", compare: true });
      if (prepared) { setAmbient(true); setPlaying(true); }
      return;
    }
    const next = await mutate("run");
    if (next?.status === "replayed") {
      progressRef.current = 0; setProgress(0); setAmbient(true); setPlaying(true);
    }
  }

  async function restoreStudy(): Promise<void> {
    if (!experiment) return;
    await change({ selectedIndex: experiment.defaultIndex, alternate: experiment.alternate, view: "dna", compare: false });
  }

  async function copySession(): Promise<void> {
    if (!session) return;
    const url = new URL(location.href);
    url.searchParams.set("session", session.id);
    try {
      await navigator.clipboard.writeText(url.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch { window.prompt("Copy this session link", url.href); }
  }

  if (!session || !experiment) return (
    <main className="loading-screen">
      <Dna size={40} strokeWidth={1.2} />
      <h1>{error ? "The lab couldn't open." : "Entering the cell"}</h1>
      <p>{error || "Preparing your experiment…"}</p>
      {error && <div className="recovery-actions">
        <button className="pill" onClick={() => location.reload()}>Try again</button>
        <button className="pill" onClick={() => {
          try { localStorage.removeItem("helix-session"); } catch { /* Optional browser storage. */ }
          const url = new URL(location.href); url.searchParams.delete("session"); location.assign(url.href);
        }}>Start new experiment</button>
      </div>}
    </main>
  );

  const reference = experiment.referenceSequence[session.selectedIndex];
  const unchanged = session.alternate === reference;
  const curated = session.selectedIndex === experiment.defaultIndex && session.alternate === experiment.alternate;
  const rnaHasEvidence = curated && session.status === "replayed";
  const finishedControl = session.status === "unchanged";
  const unscored = session.status === "unscored";
  const stageIndex = VIEWS.findIndex((item) => item.key === view);
  const stageTitle = view === "cell" ? "Life begins inside a cell."
    : view === "dna" ? "One letter can change the message."
      : finishedControl ? "Same letter. Same sequence."
        : unscored ? "An edit is a question."
          : rnaHasEvidence ? progress < 0.25 ? "First, DNA is copied into RNA."
            : progress < 0.65 ? "Now, the message is spliced."
              : "39 extra RNA bases remain."
            : "DNA becomes a message.";
  const stageCaption = view === "cell"
    ? "Travel into the nucleus, where the cell keeps its DNA."
    : view === "dna"
      ? "Explore a real DNM1 sequence. Follow one published edit into RNA."
      : finishedControl ? "The selected base matches the reference. There is no mutation to predict."
        : unscored ? "This new edit has no prediction. The published example is ready to explore."
          : rnaHasEvidence ? progress < 0.25
            ? "The cell makes an RNA copy of a gene. This is an illustrated replay of the study."
            : progress < 0.65 ? "RNA pieces are joined. The study's G → A edit creates a different splice site."
              : "The study reported a 39-base extension, adding 13 amino acids to the protein."
            : "RNA carries the instructions cells use to make proteins. Start the published example to see the splice.";
  const primaryLabel = view === "cell" ? "Enter the nucleus"
    : playing ? "Pause replay"
      : finishedControl || unscored ? "Load the published edit"
        : rnaHasEvidence && progress > 0 && progress < 1 ? "Resume replay"
          : rnaHasEvidence && progress >= 1 ? "Replay from the start"
            : unchanged ? "Check unchanged DNA"
              : curated ? "Watch this edit" : "Check this edit";

  async function advance(): Promise<void> {
    if (view === "cell") { await change({ view: "dna", compare: false }); return; }
    if (finishedControl || unscored) { await restoreStudy(); return; }
    await replay();
  }

  return (
    <main className={`lab-shell view-${view}`}>
      <section className="world" aria-label="Interactive molecular laboratory">
        <div className="scene-stage" data-testid="scene-stage">
          <MolecularScene
            key={sceneAttempt} view={view} compare={session.compare}
            progress={rnaHasEvidence ? progress : 0} rnaHasEvidence={rnaHasEvidence}
            rnaIsUnchanged={unchanged && finishedControl} playing={playing} ambient={ambient}
            selectedIndex={session.selectedIndex} alternate={session.alternate}
            sequence={experiment.referenceSequence}
            onSelectBase={(index) => { void change({ selectedIndex: index }); }}
            resetKey={resetKey}
            onReady={() => { setReady(true); setSceneError(""); }}
            onError={(message) => { setSceneError(message); setReady(true); }}
          />
        </div>
        <div className="scene-vignette" aria-hidden="true" />
      </section>

      <div className="world-interface" inert={drawer !== null}>
        <header className="topbar">
          <a className="wordmark" href="/" aria-label="Helix home"><Dna size={26} strokeWidth={1.3} /><span>helix<span className="wordmark-dot">.</span></span></a>
          <nav className="view-switch" aria-label="Molecular view">
            {VIEWS.map((item, index) => <button key={item.key}
              className={index < stageIndex ? "visited" : ""}
              aria-pressed={view === item.key} disabled={busy}
              onClick={() => { void change({ view: item.key }); }}>
              <span>{item.number}</span>{item.label}
              {index < 2 && <ChevronRight className="journey-chevron" size={13} aria-hidden="true" />}
            </button>)}
          </nav>
          <div className="topbar-actions">
            <span className={`session-state ${connected ? "" : "disconnected"}`} role="status"><i />{!connected ? "Reconnecting" : busy ? "Saving" : "Saved"}</span>
            <button className="pill evidence-button" onClick={() => setDrawer("evidence")}><FlaskConical size={16} /><span>Evidence</span></button>
            <button className="icon-button tools-button" aria-label="Open experiment tools" title="Experiment tools" onClick={() => setDrawer("edit")}><Settings2 size={19} /></button>
          </div>
        </header>

        <div className="stage-story" key={`${view}-${finishedControl}-${unscored}`}>
          <div className="eyebrow"><span className="chapter-marker">{VIEWS[stageIndex].number}</span>{view === "cell" ? "THE CELL" : view === "dna" ? "THE DNA" : "THE RNA"}<span className="story-divider" />{experiment.gene}</div>
          <h1>{stageTitle}</h1>
          <p>{stageCaption}</p>
        </div>

        <div className="scene-tools">
          {view !== "cell" && <button className={`icon-button ${session.compare ? "active" : ""}`} aria-label="Compare reference and edit" aria-pressed={session.compare} title="Compare reference and edit" disabled={busy} onClick={() => { void change({ compare: !session.compare }); }}><SplitSquareHorizontal size={19} /></button>}
          <button className="icon-button" aria-label="Reset camera" title="Reset camera" onClick={() => setResetKey((key) => key + 1)}><Expand size={19} /></button>
        </div>
        {session.compare && view === "dna" && <div className="comparison-labels"><span><i />Reference</span><span className="alt"><i />{unchanged ? "Unchanged" : curated ? "Study variant" : "Custom edit"}</span></div>}
        {!ready && <div className="scene-loading" role="status"><span className="loading-orbit" />Preparing molecular view…</div>}
        {sceneError && <div className="scene-fallback" role="alert"><Dna size={32} /><strong>3D view unavailable</strong><p>You can still edit the sequence and explore the evidence.</p><span>{sceneError}</span><button className="pill" onClick={() => { setSceneError(""); setReady(false); setSceneAttempt((attempt) => attempt + 1); }}>Retry 3D view</button></div>}

        <section className="journey-action" aria-label="Experiment controls">
          {view !== "cell" && <div className="selection-summary">
            <button className="edit-selection" onClick={() => setDrawer("edit")} aria-label={`Edit selected DNA letter ${reference} to ${session.alternate}`}>
              <span className="reference-letter">{reference}</span><ArrowRight size={16} /><span className="alternate-letter">{session.alternate}</span>
              <span className="selection-kind">{unchanged ? "Reference control" : curated ? "Published edit" : "Custom edit"}</span><Settings2 size={14} />
            </button>
            {(finishedControl || unscored) && <span className="result-state" role="status">{finishedControl ? "No DNA change" : "Not scored"}</span>}
          </div>}
          {rnaHasEvidence && view === "rna" && <div className="playback-strip">
            <input aria-label="Replay progress" type="range" min={0} max={1} step={0.001} value={progress}
              onChange={(event) => { setPlaying(false); setAmbient(false); const next = Number(event.target.value); setProgress(next); progressRef.current = next; }}
              onPointerUp={() => { void mutate("patch", { progress: progressRef.current }); }}
              onKeyUp={() => { void mutate("patch", { progress: progressRef.current }); }} />
            <span>{String(Math.round(progress * 16)).padStart(2, "0")} <i>/ 16s</i></span>
          </div>}
          <div className="action-row">
            {view !== "cell" && <button className="back-button icon-button" aria-label={view === "dna" ? "Back to cell" : "Back to DNA"} title={view === "dna" ? "Back to cell" : "Back to DNA"} disabled={busy} onClick={() => { void change({ view: view === "dna" ? "cell" : "dna" }); }}><ArrowLeft size={19} /></button>}
            <button className="run-button" disabled={busy} onClick={() => { void advance(); }}>
              {playing ? <Pause size={18} fill="currentColor" /> : view !== "cell" && !finishedControl && !unscored ? <Play size={17} fill="currentColor" /> : null}
              <span>{primaryLabel}</span>{!playing && <ArrowRight size={19} />}
            </button>
          </div>
          <p className="replay-caption">{view === "cell" ? "An illustrated journey from cell to DNA to RNA." : unchanged ? "Unchanged sequence · no model prediction needed" : curated ? "Published findings, illustrated in 3D · no live model" : "New edits are unscored · no effect has been inferred"}</p>
        </section>

        <footer className="lab-footer"><span className="scene-kind"><i />{view === "rna" ? "Schematic RNA · not to scale" : "Illustrative molecular structure"}</span><span className="orbit-hint">Drag to explore<span>·</span>Scroll to zoom</span><button className="text-button" onClick={() => setDrawer("concept")}><Sparkles size={14} />Imagination</button></footer>
      </div>

      {error && <div className="toast" role="alert">{error}<button className="icon-button" aria-label="Dismiss error" onClick={clearError}><X size={17} /></button></div>}
      {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(null)}>
        <aside className={`drawer drawer-${drawer}`} ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="drawer-title" onClick={(event) => event.stopPropagation()}>
          <header><span className="eyebrow">{drawer === "edit" ? "YOUR EXPERIMENT" : drawer === "evidence" ? "THE SCIENCE" : "HIGGSFIELD · CONCEPT"}</span><button className="icon-button" aria-label="Close panel" onClick={() => setDrawer(null)}><X size={22} /></button></header>
          {drawer === "edit" ? <>
            <h2 id="drawer-title">Change one letter.</h2>
            <p className="drawer-intro">Choose a position, then an alternate base. Only the published G → A example has a replay.</p>
            <div className="edit-block"><div className="control-label"><span>{experiment.gene}</span><span>{experiment.locus.assembly} · {experiment.locus.chromosome}</span></div><div className="letter-change"><span className="reference-letter">{reference}</span><ArrowRight size={28} strokeWidth={1.3} /><span className="alternate-letter">{session.alternate}</span></div>
              <div className="base-options" aria-label="Choose alternate DNA letter">{BASES.map((base) => <button key={base} aria-label={`Change DNA letter to ${base}`} aria-pressed={session.alternate === base} className={session.alternate === base ? "selected" : ""} disabled={busy} onClick={() => { void change({ alternate: base }); }}>{base}{base === reference && <span>Reference</span>}</button>)}</div>
              <div className="coordinate"><span>Position {(experiment.locus.start + session.selectedIndex).toLocaleString("en-US")}</span><span>{unchanged ? "Unchanged" : curated ? "Study variant" : "Custom edit"}</span></div>
            </div>
            <section className="sequence-dock" aria-label="Sequence editing"><div className="sequence-heading"><h3>Reference sequence</h3><span>{experiment.referenceSequence.length} bases</span></div><p>Select a letter to inspect or edit it.</p><div className="sequence-row"><span className="strand-label">5′</span><div className="sequence-scroll">{experiment.referenceSequence.split("").map((base, index) => <button key={index} ref={session.selectedIndex === index ? selectedRef : undefined} aria-label={`Base ${index + 1}: ${base}`} aria-pressed={session.selectedIndex === index} className={session.selectedIndex === index ? "chosen" : ""} disabled={busy} onClick={() => { void change({ selectedIndex: index }); }}><span>{base}</span><i>{index === session.selectedIndex ? session.alternate : "·"}</i></button>)}</div><span className="strand-label">3′</span></div></section>
            <div className="edit-truth"><span className={`truth-dot ${curated ? "curated" : ""}`} /><p>{unchanged ? "Reference and alternate match. Checking this control confirms there is no DNA change." : curated ? "This exact edit has a published RNA-splicing example. The 3D movement illustrates that evidence." : "This is a new edit. No molecular effect or trait has been predicted for it."}</p></div>
            <button className="drawer-primary" disabled={busy} onClick={() => { setDrawer(null); void change({ view: "dna" }); }}>Explore this sequence<ArrowRight size={18} /></button>
            {!curated && <button className="restore-button text-button" disabled={busy} onClick={() => { void restoreStudy(); }}>Load the published G → A edit<RotateCcw size={15} /></button>}
            <div className="tool-list"><button onClick={() => { setPlaying(false); setAmbient(true); void mutate("reset"); setResetKey((key) => key + 1); }} disabled={busy}><RotateCcw size={18} /><span>Reset experiment</span></button><button onClick={() => { setAmbient(!ambient); if (ambient && playing) { setPlaying(false); void mutate("patch", { progress: progressRef.current }); } }}>{ambient ? <Pause size={18} /> : <Play size={18} />}<span>{ambient ? "Pause scene motion" : "Resume scene motion"}</span></button><button onClick={() => { void copySession(); }}>{copied ? <Check size={18} /> : <Link2 size={18} />}<span>{copied ? "Link copied" : "Copy session link"}</span></button><a href={`/api/sessions/${session.id}/export`} aria-label="Export experiment JSON"><ArrowDownToLine size={18} /><span>Export experiment JSON</span></a></div>
            <p className="save-note"><span className="dot" />{connected ? busy ? "Saving your changes…" : "Your session is saved automatically." : "Connection interrupted. Your last saved session is retained."}</p>
          </> : drawer === "evidence" ? <>
            <h2 id="drawer-title">One edit.<br />A different splice.</h2><div className="evidence-variant">{experiment.gene}<span>G → A</span><span className="evidence-tag">Published case</span></div>
            <div className="evidence-section"><h3>What the study predicted</h3><p>{experiment.mechanism}</p></div><div className="evidence-section"><h3>Experimental evidence</h3><p>{experiment.evidence}</p></div><div className="evidence-section"><h3>What this lab shows</h3><p>{experiment.limitation}</p></div>
            <p className="reference-note">Verified {experiment.locus.assembly} sequence · {experiment.locus.strand === "+" ? "forward" : "reverse"} strand.<br />The {experiment.referenceSequence.length}-base excerpt is real; molecular shapes and movement are illustrative. This excerpt does not contain the full RNA extension.</p>
            <div className="source-links">{experiment.sources.map((source) => <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>{source.title}<ExternalLink size={16} /></a>)}</div>
          </> : <>
            <h2 id="drawer-title">Beyond the known.</h2><p className="drawer-intro">An imagined arachnid-inspired being.</p><div className="concept-image-wrap">{conceptError ? <div className="concept-pending"><Sparkles size={30} /><span>Concept artwork is unavailable.</span></div> : <img src="/concepts/arachnid-concept.png" alt="Fictional arachnid-inspired humanoid concept generated with Higgsfield" onError={() => setConceptError(true)} />}<span className="concept-badge">CONCEPT ART</span></div><p className="concept-boundary">Creative visualization by Higgsfield.<br /><strong>Not a predicted effect of this DNA edit.</strong></p><p className="concept-footnote">This artwork explores imagination. The experiment shows a molecular mechanism supported by published evidence.</p>
          </>}
        </aside>
      </div>}
    </main>
  );
}
