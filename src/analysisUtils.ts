import { scoreDatasetSchema, analysisDatasetSchema, type AnalysisDataset, type AnalysisProvenance, type AnalysisTrackMetadata, type JunctionDataset, type MeasurementDataset, type MeasurementRow, type ScoreDataset, type ScoreRow, type TrackRow } from '../shared/analysis';
import type { FigureSettings } from '../shared/analysis-record';
import publishedRows from '../data/atlas/published-tcell-scores.normalized.json';
import publishedProvenance from '../data/atlas/published-tcell-scores.provenance.json';
import dnm1Measurements from '../data/experimental/dnm1-table-s4.measurements.json';
import dnm1Provenance from '../data/experimental/dnm1-table-s4.provenance.json';

export const PUBLISHED_PROVENANCE = publishedProvenance;
export const DEFAULT_DATASET: ScoreDataset = scoreDatasetSchema.parse({
  schemaVersion: 1,
  id: 'alphagenome-published-tcell-2025-07-21',
  title: 'Four variants in T-cells',
  kind: 'scores',
  provenance: {
    sourceUrl: publishedProvenance.source_notebook_url,
    sourceLabel: 'Google DeepMind · AlphaGenome notebook',
    assembly: 'GRCh38',
    model: 'AlphaGenome · version not recorded',
    context: 'Published notebook output; execution timestamp 21 July 2025. Four example variants, T-cells only. Not a live Atlas query or inference.',
    recordedAt: publishedProvenance.notebook_execution_timestamp_utc,
    mode: 'published-example',
  },
  rows: publishedRows,
});
export const DNM1_MEASUREMENT_SOURCE = dnm1Provenance;
export const DNM1_MEASUREMENTS = analysisDatasetSchema.parse({
  schemaVersion: 1, id: dnm1Measurements.id, title: 'DNM1 · measured splicing rates', kind: 'measurements',
  provenance: {
    sourceUrl: dnm1Measurements.sourceUrl, sourceLabel: 'AlphaGenome Atlas paper · Table S4', assembly: dnm1Measurements.assembly,
    model: 'Not applicable', mode: 'published-example',
    context: `${dnm1Measurements.selection} ${dnm1Measurements.sourcePrecision} Experimental measurements only; no matched model predictions.`,
    artifact: { filename: 'alphagenome-atlas.pdf', sha256: dnm1Provenance.sourceSha256 },
  },
  experiment: {
    assay: dnm1Measurements.assay, endpoint: dnm1Measurements.measurement, unit: 'fraction', unitLabel: 'Alternative 3′ splice-site selection rate',
    aggregation: 'mean_of_condition_means', conditions: ['Aggregate across five retained cell-line/promoter combinations; individual conditions not specified in Table S4'],
    replicatePolicy: dnm1Provenance.replicateUncertainty, sourceLocator: 'Table S4 · page 73; Figure 3D · page 9; quantification methods · page 44',
  },
  rows: dnm1Measurements.rows.map(row => ({ variant: row.variant, gene: row.gene, value: row.alt3ssRate, reportedValue: row.alt3ssRateReportedText, replicates: row.validReplicateCount, standardError: row.standardError, sourceRowIndex: row.sourceRow })),
}) as MeasurementDataset;

/** A raw-score series is a single method, track, strand and unit. */
export function comparisonKey(row: ScoreRow): string {
  return JSON.stringify([row.modality, row.scorer, row.track || '', row.trackStrand || '', row.unit || '', row.signed ?? null]);
}
export function defaultSettings(dataset: AnalysisDataset): FigureSettings {
  if (dataset.kind === 'junctions') return { chart: 'junctions', title: 'Reference and alternate RNA connections', modality: 'SPLICE_JUNCTIONS', scorer: '', track: '', gene: '', metric: 'score', limit: 12, variant: '' };
  if (dataset.kind === 'measurements') return { chart: 'bars', title: dataset.experiment.unit === 'fraction' || dataset.experiment.unit === 'percent' ? 'Measured experimental rate' : 'Measured experimental value', modality: '', scorer: '', track: '', gene: '', metric: 'score', limit: 12, variant: '' };
  const first = dataset.kind === 'scores' ? dataset.rows.find(row => row.modality === 'ATAC') || dataset.rows[0] : undefined;
  return { chart: dataset.kind === 'scores' ? 'bars' : 'tracks', title: dataset.kind === 'scores' ? 'Predicted variant effects' : 'Reference and alternate signal',
    modality: first?.modality || '', scorer: first?.scorer || '', track: first ? comparisonKey(first) : '', gene: '', metric: 'score', limit: 12, variant: '' };
}
/** Preserve source order and experimental values; never manufacture model scores. */
export function matchingMeasurements(dataset: AnalysisDataset, settings: FigureSettings): MeasurementRow[] {
  return dataset.kind === 'measurements' ? dataset.rows.filter(row => (!settings.gene || row.gene === settings.gene) && (!settings.variant || row.variant === settings.variant)) : [];
}
export function measurementValue(row: MeasurementRow): string { return row.reportedValue ?? formatScore(row.value, 7); }
export function measurementAggregation(dataset: MeasurementDataset): string { return dataset.experiment.aggregation === 'mean_of_condition_means' ? 'Mean of condition means' : dataset.experiment.aggregation.replaceAll('_', ' '); }
export function distinct(values: string[]): string[] { return [...new Set(values)].sort((a, b) => a.localeCompare(b)); }
export function scoreValue(row: ScoreRow, metric: FigureSettings['metric']): number | undefined { return metric === 'quantile' ? row.quantile : row.score; }
export function matchingRows(dataset: AnalysisDataset, settings: FigureSettings): ScoreRow[] {
  if (dataset.kind !== 'scores') return [];
  return dataset.rows.filter(row => row.modality === settings.modality && row.scorer === settings.scorer && comparisonKey(row) === settings.track
    && (!settings.gene || row.gene === settings.gene || row.geneId === settings.gene)
    && (!settings.variant || row.variant === settings.variant)
    && scoreValue(row, settings.metric) !== undefined);
}
export function rankedRows(dataset: AnalysisDataset, settings: FigureSettings): ScoreRow[] {
  return matchingRows(dataset, settings).sort((a, b) => Math.abs(scoreValue(b, settings.metric) || 0) - Math.abs(scoreValue(a, settings.metric) || 0)
    || `${a.variant}:${a.geneId || a.gene || ''}:${a.sourceRowIndex || ''}`.localeCompare(`${b.variant}:${b.geneId || b.gene || ''}:${b.sourceRowIndex || ''}`));
}
export function featureKey(row: ScoreRow): string { return JSON.stringify([row.geneId || row.gene || '', row.geneStrand || '', row.biosample, row.track || '', row.trackStrand || '']); }
export function featureLabel(row: ScoreRow): string { return row.gene || row.geneId ? `${row.gene || row.geneId} · ${row.biosample}` : row.biosample || row.track || row.modality; }
export function rowLabel(row: ScoreRow): string { return `${row.gene ? `${row.gene} · ` : ''}${row.variant} · ${row.biosample}`; }
export function formatScore(value: number | undefined, precision = 3): string {
  if (value === undefined) return '—';
  if (value === 0) return '0';
  if (Math.abs(value) < .001 || Math.abs(value) >= 100000) return value.toExponential(2);
  return Number(value.toPrecision(precision)).toString();
}
export function modalityLabel(value: string): string {
  return ({ ATAC: 'Chromatin accessibility · ATAC', DNASE: 'Chromatin accessibility · DNase', CHIP_HISTONE: 'Histone marks', RNA_SEQ: 'RNA expression', SPLICE_SITE_USAGE: 'Splice-site usage', SPLICE_JUNCTIONS: 'Splice junctions' } as Record<string, string>)[value] || value;
}
export function scorerLabel(value: string): string {
  return value.split('(')[0].replace(/Scorer$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}
export function trackLabel(row: ScoreRow): string { return `${row.track || row.biosample || 'Unspecified track'}${row.trackStrand && row.trackStrand !== '.' ? ` · ${row.trackStrand} strand` : ''}`; }
export function unitLabel(rows: ScoreRow[], settings: FigureSettings): string { return settings.metric === 'quantile' ? 'Signed quantile score' : rows[0]?.unit || 'Raw score · unit not supplied'; }
export function downloadFile(content: string | Blob, name: string, type = 'text/plain;charset=utf-8', signal?: AbortSignal): void {
  signal?.throwIfAborted();
  const blob = typeof content === 'string' ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = name;
  try { signal?.throwIfAborted(); link.click(); } catch (cause) { URL.revokeObjectURL(url); throw cause; }
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function csvForRows(rows: ScoreRow[]): string {
  const columns = ['variant', 'gene', 'geneId', 'biosample', 'modality', 'scorer', 'track', 'trackStrand', 'unit', 'signed', 'score', 'quantile', 'sourceRowIndex', 'scoredInterval'] as const;
  const cell = (value: unknown): string => value === undefined ? '' : `"${String(value).replaceAll('"', '""')}"`;
  return [columns.join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\n');
}
export async function exportFigure(svg: SVGSVGElement, kind: 'svg' | 'png', filename: string, metadata?: { title: string; source: string; sourceUrl: string; assembly: string; status: string; provenance?: AnalysisProvenance; settings?: FigureSettings; experiment?: MeasurementDataset['experiment']; junctions?: Pick<JunctionDataset, 'interval' | 'variant' | 'rows' | 'trackMetadata'>; tracks?: Array<{ chromosome: string; track: string; metadata: AnalysisTrackMetadata | null }> }, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const view = svg.viewBox.baseVal;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); clone.setAttribute('width', String(view.width)); clone.setAttribute('height', String(view.height));
  clone.removeAttribute('class'); clone.style.cssText = '';
  if (metadata) {
    const namespace = 'http://www.w3.org/2000/svg';
    const group = document.createElementNS(namespace, 'g'); group.setAttribute('transform', 'translate(0 65)');
    while (clone.firstChild) group.appendChild(clone.firstChild);
    const totalHeight = view.height + 130;
    clone.setAttribute('viewBox', `0 0 ${view.width} ${totalHeight}`); clone.setAttribute('height', String(totalHeight));
    const bg = document.createElementNS(namespace, 'rect'); bg.setAttribute('width', String(view.width)); bg.setAttribute('height', String(totalHeight)); bg.setAttribute('fill', 'white'); clone.appendChild(bg); clone.appendChild(group);
    const addText = (content: string, y: number, size: number, fill: string): void => { const node = document.createElementNS(namespace, 'text'); node.setAttribute('x', '26'); node.setAttribute('y', String(y)); node.setAttribute('font-size', String(size)); node.setAttribute('font-family', 'Arial, sans-serif'); node.setAttribute('fill', fill); node.textContent = content; clone.appendChild(node); };
    addText(metadata.title, 29, 17, '#243950'); addText(metadata.assembly, 48, 10, '#6e829c');
    addText(metadata.source, totalHeight - 35, 10, '#536b8b'); addText(metadata.status, totalHeight - 17, 9, '#7f8fa5');
    const meta = document.createElementNS(namespace, 'metadata'); meta.textContent = JSON.stringify(metadata); clone.appendChild(meta);
  }
  const serialized = new XMLSerializer().serializeToString(clone);
  if (kind === 'svg') { downloadFile(serialized, `${filename}.svg`, 'image/svg+xml', signal); return; }
  const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { img.onload = null; img.onerror = null; signal?.removeEventListener('abort', abort); };
      const abort = (): void => { cleanup(); img.src = ''; reject(new DOMException('Export cancelled because the account changed.', 'AbortError')); };
      img.onload = () => { cleanup(); resolve(); };
      img.onerror = () => { cleanup(); reject(new Error('The figure could not be rendered. Try SVG export.')); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else img.src = url;
    });
    signal?.throwIfAborted();
    const canvas = document.createElement('canvas'); canvas.width = view.width * 2; canvas.height = (view.height + (metadata ? 130 : 0)) * 2;
    const context = canvas.getContext('2d'); if (!context) throw new Error('PNG export is unavailable. Use SVG instead.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG export failed.')), 'image/png'));
    signal?.throwIfAborted();
    downloadFile(blob, `${filename}.png`, 'image/png', signal);
  } finally { URL.revokeObjectURL(url); }
}
export function importProvenance(assembly: string, sourceUrl: string, sourceLabel: string): AnalysisProvenance {
  return { assembly, sourceUrl, sourceLabel: sourceLabel || 'User import', model: 'Not supplied', context: 'User-supplied data. Not independently verified.', mode: 'imported' };
}
export function trackGroups(rows: TrackRow[], metadata: AnalysisTrackMetadata[] = []): Array<{ key: string; label: string; rows: TrackRow[]; metadata?: AnalysisTrackMetadata }> {
  const groups = new Map<string, TrackRow[]>();
  const byTrack = new Map(metadata.map(item => [JSON.stringify([item.chromosome, item.track]), item]));
  for (const row of rows) { const key = JSON.stringify([row.chromosome, row.track]); groups.set(key, [...(groups.get(key) || []), row]); }
  return [...groups].map(([key, values]) => ({ key, label: `${values[0].chromosome} · ${values[0].track}`, rows: values.sort((a, b) => a.position - b.position), metadata: byTrack.get(key) }));
}
export function signalUnit(metadata?: Pick<AnalysisTrackMetadata, 'unit'>): string { return metadata?.unit || 'Unit not provided'; }
export function signalStrand(metadata?: Pick<AnalysisTrackMetadata, 'strand'>): string { return metadata?.strand === '.' ? 'Unstranded' : metadata?.strand === '+' || metadata?.strand === '-' ? `${metadata.strand} strand` : 'Strand unspecified'; }
export function signalScope(metadata?: Pick<AnalysisTrackMetadata, 'scope' | 'biosampleName' | 'biosampleId'>): string {
  if (metadata?.scope === 'tissue_agnostic') return 'Tissue-agnostic';
  if (metadata?.scope === 'biosample_specific') return `Biosample-specific · ${metadata.biosampleName || metadata.biosampleId}`;
  return 'Scope unspecified';
}
export function signalMetadataLabel(metadata?: AnalysisTrackMetadata): string {
  return `${signalStrand(metadata)} · ${signalScope(metadata)} · ${metadata ? `${metadata.binSize} bp bins` : 'Bin size unspecified'}`;
}
export function inferenceSourceStatus(provenance: AnalysisProvenance): string {
  if (provenance.mode === 'published-example') return 'Published model output snapshot · no live inference performed';
  return provenance.inference ? 'Imported model output · execution reported by source' : 'Supplied data · no inference performed';
}
/** Draw declared bins as constant segments, starting a new path at missing bins. */
export function binnedSignalPath(rows: TrackRow[], kind: 'reference' | 'alternate', binSize: number, x: (position: number) => number, y: (value: number) => number): string {
  return rows.map((row, index) => `${index && rows[index - 1].position + binSize === row.position ? 'L' : 'M'} ${x(row.position)} ${y(row[kind])} H ${x(row.position + binSize)}`).join(' ');
}
