import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronRight,
  Dna,
  Expand,
  ExternalLink,
  FlaskConical,
  Link2,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  SplitSquareHorizontal,
  X,
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

export default function App() {
  const { session, experiment, error, busy, mutate, clearError } = useLab();
  const [drawer, setDrawer] = useState<"evidence" | "concept" | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [resetKey, setResetKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [ready, setReady] = useState(false);
  const [conceptError, setConceptError] = useState(false);
  const progressRef = useRef(0);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (session && !playing) {
      setProgress(session.progress);
      progressRef.current = session.progress;
    }
  }, [session]);
  useEffect(() => {
    const target = selectedRef.current;
    const strip = target?.parentElement;
    if (target && strip) {
      const targetBox = target.getBoundingClientRect();
      const stripBox = strip.getBoundingClientRect();
      strip.scrollTo({
        left:
          strip.scrollLeft +
          targetBox.left -
          stripBox.left -
          (strip.clientWidth - target.clientWidth) / 2,
        behavior: "smooth",
      });
    }
  }, [session?.selectedIndex]);
  useEffect(() => {
    setPlaying(false);
  }, [session?.selectedIndex, session?.alternate]);
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
      if (event.key === "Tab") {
        const focusable =
          drawerRef.current?.querySelectorAll<HTMLElement>("button, a[href]");
        if (!focusable?.length) return;
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
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
    await mutate("patch", patch);
  }

  async function replay(): Promise<void> {
    if (playing) {
      setPlaying(false);
      await mutate("patch", { progress: progressRef.current });
      return;
    }
    if (
      session?.status === "replayed" &&
      progressRef.current > 0 &&
      progressRef.current < 1
    ) {
      const prepared = await mutate("patch", { view: "rna", compare: true });
      if (prepared) setPlaying(true);
      return;
    }
    const next = await mutate("run");
    if (next?.status === "replayed") {
      const prepared = await mutate("patch", {
        view: "rna",
        compare: true,
        progress: 0,
      });
      if (!prepared) return;
      progressRef.current = 0;
      setProgress(0);
      setPlaying(true);
    }
  }

  async function copySession(): Promise<void> {
    if (!session) return;
    const url = new URL(location.href);
    url.searchParams.set("session", session.id);
    try {
      await navigator.clipboard.writeText(url.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      window.prompt("Copy this local session link", url.href);
    }
  }

  if (!session || !experiment)
    return (
      <main className="loading-screen">
        <Dna size={32} />
        <p>{error || "Opening the lab"}</p>
        {error && (
          <button className="pill" onClick={() => location.reload()}>
            Try again
          </button>
        )}
      </main>
    );

  const reference = experiment.referenceSequence[session.selectedIndex];
  const curated =
    session.selectedIndex === experiment.defaultIndex &&
    session.alternate === experiment.alternate;
  const rnaHasEvidence = curated && session.status === "replayed";

  return (
    <main className="lab-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="Helix home">
          <Dna size={27} strokeWidth={1.4} />
          <span>
            helix<span className="wordmark-dot">.</span>
          </span>
          <span className="lab-label">DNA LAB</span>
        </a>
        <div className="topbar-actions">
          <span className="session-state">
            <i />
            {busy ? "Saving" : "Local session"}
          </span>
          <button className="text-button" onClick={() => setDrawer("concept")}>
            <Sparkles size={16} />
            <span>Concept</span>
          </button>
          <button
            className="pill evidence-button"
            onClick={() => setDrawer("evidence")}
          >
            <FlaskConical size={16} />
            Evidence
            <ChevronRight size={14} />
          </button>
        </div>
      </header>

      <section
        className="workspace"
        aria-label="Interactive molecular laboratory"
      >
        <div className="scene-stage" data-testid="scene-stage">
          <MolecularScene
            view={session.view}
            compare={session.compare}
            progress={rnaHasEvidence ? progress : 0}
            rnaHasEvidence={rnaHasEvidence}
            playing={playing}
            selectedIndex={session.selectedIndex}
            alternate={session.alternate}
            sequence={experiment.referenceSequence}
            onSelectBase={(index) => {
              void change({ selectedIndex: index });
            }}
            resetKey={resetKey}
            onReady={() => setReady(true)}
          />
        </div>
        <div className="scene-vignette" />

        <aside className="experiment-sidebar">
          <div className="eyebrow">
            <span className="small-line" />
            EXPERIMENT 001
          </div>
          <h1>
            One letter.
            <br />
            <span>
              A different
              <br className="desktop-break" /> story.
            </span>
          </h1>
          <div className="experiment-meta">
            <strong>{experiment.gene}</strong>
            <span>RNA splicing</span>
          </div>
          <button className="source-chip" onClick={() => setDrawer("evidence")}>
            <span className="dot" />
            Published case
            <ArrowRight size={13} />
          </button>

          <div className="edit-block">
            <div className="control-label">
              DNA EDIT<span>GRCh38 · chr9</span>
            </div>
            <div className="letter-change">
              <span className="reference-letter">{reference}</span>
              <ArrowRight size={24} strokeWidth={1} />
              <span className="alternate-letter">{session.alternate}</span>
            </div>
            <div
              className="base-options"
              aria-label="Choose alternate DNA letter"
            >
              {BASES.map((base) => (
                <button
                  key={base}
                  aria-label={`Change DNA letter to ${base}`}
                  aria-pressed={session.alternate === base}
                  className={session.alternate === base ? "selected" : ""}
                  disabled={busy}
                  onClick={() => {
                    void change({ alternate: base });
                  }}
                >
                  {base}
                </button>
              ))}
            </div>
            <div className="coordinate">
              {(128225974 + session.selectedIndex).toLocaleString("en-US")}
              <span>{curated ? "Study variant" : "Custom edit"}</span>
            </div>
          </div>

          <button
            className="run-button"
            disabled={busy}
            onClick={() => {
              void replay();
            }}
          >
            {playing ? (
              <Pause size={17} fill="currentColor" />
            ) : (
              <Play size={17} fill="currentColor" />
            )}
            {playing
              ? "Pause replay"
              : rnaHasEvidence && progress > 0 && progress < 1
                ? "Resume replay"
                : curated
                  ? "Replay experiment"
                  : "Check this edit"}
            <span>{playing ? "" : "↗"}</span>
          </button>
          <div className="replay-caption">
            {curated
              ? "Published findings. Illustrated in 3D."
              : "No prediction available for this edit."}
          </div>
        </aside>

        {session.status === "unscored" && (
          <div className="result-note" role="status">
            <strong>Not scored</strong>
            <span>Live prediction is not connected.</span>
            <button
              onClick={() => {
                void mutate("reset");
              }}
            >
              Return to study variant
              <ArrowRight size={13} />
            </button>
          </div>
        )}
        {rnaHasEvidence && (
          <div className="result-note observed" aria-live="polite">
            <strong>39 extra RNA bases</strong>
            <span>Reported extension · 13 amino acids</span>
          </div>
        )}

        <div className="view-switch" aria-label="Molecular view">
          {VIEWS.map((view) => (
            <button
              key={view.key}
              aria-pressed={session.view === view.key}
              onClick={() => {
                void change({ view: view.key });
              }}
            >
              <span>{view.number}</span>
              {view.label}
            </button>
          ))}
        </div>

        <div className="canvas-toolbar">
          {session.view !== "cell" && (
            <button
              className={`pill ${session.compare ? "active" : ""}`}
              aria-label="Compare reference and edit"
              aria-pressed={session.compare}
              onClick={() => {
                void change({ compare: !session.compare });
              }}
            >
              <SplitSquareHorizontal size={16} />
              <span>Compare</span>
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Reset camera"
            title="Reset camera"
            onClick={() => setResetKey((key) => key + 1)}
          >
            <Expand size={18} />
          </button>
        </div>
        <div className="scene-caption">
          <span className="crosshair">+</span>
          {session.view === "cell"
            ? "CELL → NUCLEUS"
            : session.view === "dna"
              ? "DOUBLE HELIX"
              : "RNA ASSEMBLY"}
          <span className="scene-kind">
            {session.view === "rna"
              ? "Schematic · not to scale"
              : "Illustrative structure"}
          </span>
        </div>
        {session.compare && session.view === "dna" && (
          <div className="comparison-labels">
            <span>
              <i />
              Reference
            </span>
            <span className="alt">
              <i />
              {rnaHasEvidence ? "Study variant" : "Edited letter"}
            </span>
          </div>
        )}
        {!ready && (
          <div className="scene-loading">Preparing molecular view…</div>
        )}
        <span className="orbit-hint">
          Drag to orbit <span>·</span> Scroll to zoom
        </span>
      </section>

      <section
        className="sequence-dock"
        aria-label="Sequence and playback controls"
      >
        <div className="sequence-heading">
          <span className="control-label">REFERENCE SEQUENCE</span>
          <span>
            41 bases<span className="sequence-separator">/</span>Select a letter
          </span>
        </div>
        <div className="sequence-row">
          <span className="strand-label">5′</span>
          <div className="sequence-scroll">
            {experiment.referenceSequence.split("").map((base, index) => (
              <button
                key={index}
                ref={session.selectedIndex === index ? selectedRef : undefined}
                aria-label={`Base ${index + 1}: ${base}`}
                aria-pressed={session.selectedIndex === index}
                className={session.selectedIndex === index ? "chosen" : ""}
                onClick={() => {
                  void change({ selectedIndex: index });
                }}
              >
                <span>{base}</span>
                <i>
                  {index === session.selectedIndex ? session.alternate : "·"}
                </i>
              </button>
            ))}
          </div>
          <span className="strand-label">3′</span>
        </div>
        <div className="transport">
          <button
            className="icon-button"
            aria-label="Reset experiment"
            title="Reset experiment"
            onClick={() => {
              setPlaying(false);
              void mutate("reset");
              setResetKey((key) => key + 1);
            }}
          >
            <RotateCcw size={16} />
          </button>
          <button
            className="icon-button play-small"
            aria-label={playing ? "Pause experiment" : "Play experiment"}
            disabled={busy}
            onClick={() => {
              void replay();
            }}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <input
            aria-label="Replay progress"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={progress}
            disabled={!rnaHasEvidence}
            onChange={(event) => {
              setPlaying(false);
              const next = Number(event.target.value);
              setProgress(next);
              progressRef.current = next;
            }}
            onPointerUp={() => {
              void mutate("patch", { progress: progressRef.current });
            }}
            onKeyUp={() => {
              void mutate("patch", { progress: progressRef.current });
            }}
          />
          <span className="time-label">
            {String(Math.round(progress * 16)).padStart(2, "0")}
            <span> / 16s</span>
          </span>
          <div className="transport-divider" />
          <button
            className="icon-button"
            aria-label="Copy local session link"
            title="Copy local session link"
            onClick={() => {
              void copySession();
            }}
          >
            {copied ? <Check size={16} /> : <Link2 size={16} />}
          </button>
          <a
            className="icon-button"
            href={`/api/sessions/${session.id}/export`}
            aria-label="Export experiment JSON"
            title="Export experiment"
          >
            <ArrowDownToLine size={16} />
          </a>
        </div>
      </section>

      <footer className="lab-footer">
        <span>
          <i className="dot" />
          {rnaHasEvidence ? "Published replay" : "Exploration"}
          <span className="footer-separator">/</span>AlphaGenome Atlas
        </span>
        <a
          href="https://github.com/Mukhsin0508/helix-dna-lab"
          target="_blank"
          rel="noreferrer"
        >
          Development preview
          <ArrowRight size={12} />
        </a>
      </footer>

      {error && (
        <div className="toast" role="alert">
          {error}
          <button
            className="icon-button"
            aria-label="Dismiss error"
            onClick={clearError}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {drawer && (
        <div className="drawer-backdrop" onClick={() => setDrawer(null)}>
          <aside
            className={`drawer ${drawer === "concept" ? "concept-drawer" : ""}`}
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="drawer-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <span className="eyebrow">
                {drawer === "evidence" ? "THE SCIENCE" : "HIGGSFIELD · CONCEPT"}
              </span>
              <button
                className="icon-button"
                aria-label="Close panel"
                onClick={() => setDrawer(null)}
              >
                <X size={20} />
              </button>
            </header>
            {drawer === "evidence" ? (
              <>
                <h2 id="drawer-title">
                  One edit.
                  <br />A different splice.
                </h2>
                <div className="evidence-variant">
                  DNM1 <span>G → A</span>
                </div>
                <div className="evidence-section">
                  <span className="section-number">01</span>
                  <div>
                    <h3>Published prediction</h3>
                    <p>{experiment.mechanism}</p>
                  </div>
                </div>
                <div className="evidence-section">
                  <span className="section-number">02</span>
                  <div>
                    <h3>Experimental evidence</h3>
                    <p>{experiment.evidence}</p>
                  </div>
                </div>
                <div className="evidence-section">
                  <span className="section-number">03</span>
                  <div>
                    <h3>What this lab shows</h3>
                    <p>{experiment.limitation}</p>
                  </div>
                </div>
                <p className="reference-note">
                  Verified GRCh38 sequence · forward strand.
                  <br />
                  The 41-base excerpt is real; molecular shapes and movement are
                  illustrative. The excerpt does not contain the full RNA
                  extension.
                </p>
                <div className="source-links">
                  {experiment.sources.map((source) => (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      key={source.url}
                    >
                      {source.title}
                      <ExternalLink size={14} />
                    </a>
                  ))}
                </div>
              </>
            ) : (
              <>
                <h2 id="drawer-title">
                  Beyond the
                  <br />
                  known.
                </h2>
                <p className="concept-subtitle">
                  An imagined arachnid-inspired being.
                </p>
                <div className="concept-image-wrap">
                  {conceptError ? (
                    <div className="concept-pending">
                      <Sparkles size={30} />
                      <span>Concept artwork is being prepared.</span>
                    </div>
                  ) : (
                    <img
                      src="/concepts/arachnid-concept.png"
                      alt="Fictional arachnid-inspired humanoid concept generated with Higgsfield"
                      onError={() => setConceptError(true)}
                    />
                  )}
                  <span className="concept-badge">CONCEPT ART</span>
                </div>
                <p className="concept-boundary">
                  Creative visualization by Higgsfield.
                  <br />
                  <strong>Not a predicted effect of this DNA edit.</strong>
                </p>
                <p className="concept-footnote">
                  The science explores molecular changes. This separate space
                  explores imagination.
                </p>
              </>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
