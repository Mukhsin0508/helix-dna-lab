import type { AnalysisInterval, JunctionDataset, JunctionRow, JunctionTrackMetadata } from '../shared/analysis';
import type { FigureSettings } from '../shared/analysis-record';

export interface JunctionGroup {
  key: string;
  label: string;
  metadata: JunctionTrackMetadata;
  rows: JunctionRow[];
}

export function junctionTrackKey(row: Pick<JunctionRow, 'chromosome' | 'track'>): string {
  return JSON.stringify([row.chromosome, row.track]);
}

/** Both endpoints and the junction strand belong to the identity. */
export function junctionIdentity(row: JunctionRow): string {
  return JSON.stringify([row.chromosome, row.start, row.end, row.strand, row.track]);
}

/** Keep crossing junctions; a display viewport is not an endpoint containment filter. */
export function junctionOverlaps(row: JunctionRow, interval: AnalysisInterval): boolean {
  return row.chromosome === interval.chromosome && row.start < interval.end && row.end > interval.start;
}

/** Dataset row order is preserved. Figure limits never change the data selected for CSV export. */
export function selectedJunctionRows(dataset: JunctionDataset, settings: FigureSettings): JunctionRow[] {
  const variant = dataset.variant ?? dataset.provenance.inference?.variant;
  if (settings.variant && settings.variant !== variant) return [];
  return dataset.rows.filter(row => junctionOverlaps(row, dataset.interval)
    && (!settings.track || junctionTrackKey(row) === settings.track));
}

export function junctionGroups(dataset: JunctionDataset): JunctionGroup[] {
  return dataset.trackMetadata.map(metadata => ({
    key: junctionTrackKey(metadata),
    label: `${metadata.chromosome} · ${metadata.track}`,
    metadata,
    rows: dataset.rows.filter(row => row.chromosome === metadata.chromosome && row.track === metadata.track),
  })).filter(group => group.rows.length > 0);
}

export function junctionValueLabel(value: number | null): string {
  return value === null ? 'not supplied' : String(value);
}

/** One maximum for both alleles; null is excluded rather than converted to zero. */
export function junctionSharedMaximum(rows: JunctionRow[]): number {
  let maximum = 0;
  for (const row of rows) for (const value of [row.reference, row.alternate]) {
    if (value !== null) maximum = Math.max(maximum, value);
  }
  return maximum;
}

export function junctionStrokeWidth(value: number | null, maximum: number): number {
  return value === null || value === 0 || maximum <= 0 ? 0 : 6 * value / maximum;
}

export interface JunctionArcGeometry {
  path: string;
  markerX: number;
  markerY: number;
  continuations: Array<{ side: 'left' | 'right'; x: number; y: number }>;
}

/** A quadratic has a linear x(t), so clipped-boundary continuation marks are exact. */
export function junctionArcGeometry(
  row: JunctionRow, interval: AnalysisInterval, left: number, right: number, baseline: number, height: number,
): JunctionArcGeometry {
  const x = (position: number): number => left + (position - interval.start) / (interval.end - interval.start) * (right - left);
  const y = (position: number): number => {
    const t = (position - row.start) / (row.end - row.start);
    return baseline - 4 * height * t * (1 - t);
  };
  const middle = (Math.max(interval.start, row.start) + Math.min(interval.end, row.end)) / 2;
  const continuations: JunctionArcGeometry['continuations'] = [];
  if (row.start < interval.start) continuations.push({ side: 'left', x: left, y: y(interval.start) });
  if (row.end > interval.end) continuations.push({ side: 'right', x: right, y: y(interval.end) });
  return {
    path: `M ${x(row.start)} ${baseline} Q ${x((row.start + row.end) / 2)} ${baseline - 2 * height} ${x(row.end)} ${baseline}`,
    markerX: x(middle), markerY: y(middle), continuations,
  };
}

export function junctionMetadataLabel(metadata: JunctionTrackMetadata): string {
  const scope = metadata.scope === 'tissue_agnostic' ? 'Tissue-agnostic'
    : metadata.scope === 'biosample_specific' ? metadata.biosampleName || metadata.biosampleId || 'Biosample not specified'
      : 'Scope unspecified';
  return `${scope} · ${metadata.unit || 'Unit not provided'} · strand belongs to each junction`;
}
