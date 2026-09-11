import { useId, type Ref } from 'react';
import type { JunctionDataset } from '../../shared/analysis';
import type { FigureSettings } from '../../shared/analysis-record';
import { junctionArcGeometry, junctionGroups, junctionIdentity, junctionMetadataLabel, junctionSharedMaximum, junctionStrokeWidth, junctionValueLabel, selectedJunctionRows } from '../junctionUtils';

interface Props { dataset: JunctionDataset; settings: FigureSettings; width: number; svgRef: Ref<SVGSVGElement> }
const INK = '#506581', GRID = '#e8edf4', BLUE = '#365fd7', CORAL = '#d56b61', MUTED = '#8a99ae';
const MONO = 'IBM Plex Mono, ui-monospace, monospace';

function wrap(text: string, capacity: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (let word of text.split(' ')) {
    if (line && line.length + word.length + 1 > capacity) { lines.push(line); line = ''; }
    while (word.length > capacity) { lines.push(word.slice(0, capacity)); word = word.slice(capacity); }
    if (word) line += `${line ? ' ' : ''}${word}`;
  }
  if (line) lines.push(line);
  return lines;
}

function Lines({ lines, x, y, size = 10, fill = INK }: { lines: string[]; x: number; y: number; size?: number; fill?: string }) {
  return <text x={x} y={y} fontFamily={MONO} fontSize={size} fill={fill}>{lines.map((line, index) => <tspan key={index} x={x} dy={index ? size + 6 : 0}>{line}</tspan>)}</text>;
}

/** Numerical source signals only. Shape height separates arcs and does not encode an outcome. */
export default function JunctionFigure({ dataset, settings, width: suppliedWidth, svgRef }: Props) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const width = Math.max(310, Math.round(suppliedWidth)), mobile = width < 570;
  const left = mobile ? 28 : 64, right = width - (mobile ? 28 : 38), plotWidth = right - left;
  const selected = selectedJunctionRows(dataset, settings), selectedKeys = new Set(selected.map(junctionIdentity));
  const groups = junctionGroups(dataset).map(group => ({ ...group, rows: group.rows.filter(row => selectedKeys.has(junctionIdentity(row))) })).filter(group => group.rows.length);
  const variant = dataset.variant ?? dataset.provenance.inference?.variant;
  const variantMatch = variant?.match(/^(chr[^:]+):(\d+):[ACGT]>[ACGT]$/);
  const variantPosition = variantMatch && variantMatch[1] === dataset.interval.chromosome ? Number(variantMatch[2]) - 1 : null;
  const variantVisible = variantPosition !== null && variantPosition >= dataset.interval.start && variantPosition < dataset.interval.end;
  const x = (position: number): number => left + (position - dataset.interval.start) / (dataset.interval.end - dataset.interval.start) * plotWidth;
  const headerLines = wrap(`Viewport ${dataset.interval.chromosome}:${dataset.interval.start}–${dataset.interval.end} · 0-based, half-open · ${dataset.provenance.assembly}`, Math.floor(plotWidth / 5.5));
  let offset = 26 + headerLines.length * 16 + (variantVisible ? 22 : 4);
  const panels = groups.map((group, groupIndex) => {
    const rows = group.rows.slice(0, settings.limit);
    const title = wrap(group.label, Math.floor(plotWidth / 6.6));
    const details = wrap(junctionMetadataLabel(group.metadata), Math.floor(plotWidth / 5.4));
    const labelY = offset;
    const detailY = labelY + title.length * 17 + 4;
    const countY = detailY + details.length * 15 + 6;
    const referenceBase = countY + 111, alternateBase = referenceBase + 136;
    const footLines = wrap(`${rows.length}/${group.rows.length} junctions · dataset order · widths use one REF/ALT maximum: ${junctionValueLabel(junctionSharedMaximum(rows))}`, Math.floor(plotWidth / 5.3));
    const footY = alternateBase + 50;
    offset = footY + footLines.length * 15 + 45;
    return { ...group, groupIndex, rows, selectedCount: group.rows.length, title, details, labelY, detailY, countY, referenceBase, alternateBase, footY, footLines, maximum: junctionSharedMaximum(rows) };
  });
  const footer = wrap('○ zero signal   × not supplied   ◁ ▷ endpoint beyond viewport. Arc height is layout only; widths compare supplied signals.', Math.floor(plotWidth / 5.4));
  const height = Math.max(330, offset + footer.length * 15 + 20);
  const displayed = panels.flatMap(panel => panel.rows);
  if (!groups.length) return <div className="empty-state"><h3>No matching junctions</h3><p>Choose another track or variant. Missing values are not zero.</p></div>;
  return <svg ref={svgRef} className="plot-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${settings.title}. Paired reference and alternate splice junctions. ${displayed.length} of ${selected.length} selected junctions displayed, up to ${settings.limit} per track. Zero signal is an open circle; not supplied is a cross. Both alleles share each track's signal scale.`}>
    <title>{`${settings.title} · reference and alternate splice junction signals`}</title>
    <metadata>{JSON.stringify({ kind: 'junctions', interval: dataset.interval, variant, provenance: dataset.provenance, trackMetadata: panels.map(panel => panel.metadata), settings, displayedJunctions: displayed.map(junctionIdentity), displayedCount: displayed.length, selectedCount: selected.length, selection: 'First rows in dataset order, up to limit per track', scale: 'Linear width, shared maximum across both alleles for each displayed track', missingValues: 'null is not supplied; numeric zero remains zero' })}</metadata>
    <style>{`.junction-target .junction-focus { opacity: 0; } .junction-target:focus { outline: none; } .junction-target:focus .junction-focus { opacity: 1; }`}</style>
    <rect width={width} height={height} fill="white"/>
    <Lines lines={headerLines} x={left} y={23} size={9} fill={MUTED}/>
    {variantVisible && <text x={left} y={23 + headerLines.length * 16 + 4} fill={INK} fontFamily={MONO} fontSize={9}>{`${variant} · variant position is 1-based`}</text>}
    {panels.map(panel => {
      const clip = `${id}-junction-${panel.groupIndex}`;
      const spanMaximum = Math.max(...panel.rows.map(row => row.end - row.start));
      return <g key={panel.key}>
        <defs><clipPath id={clip}><rect x={left} y={panel.countY + 12} width={plotWidth} height={panel.alternateBase - panel.countY + 6}/></clipPath></defs>
        <Lines lines={panel.title} x={left} y={panel.labelY} size={11}/>
        <Lines lines={panel.details} x={left} y={panel.detailY} size={9} fill={MUTED}/>
        <text x={left} y={panel.countY} fontFamily={MONO} fontSize={8.5} fill={MUTED}>{`${panel.rows.length} of ${panel.selectedCount} supplied junctions displayed`}</text>
        {[0, .5, 1].map(tick => <line key={tick} x1={left + tick * plotWidth} x2={left + tick * plotWidth} y1={panel.countY + 30} y2={panel.alternateBase} stroke={GRID} strokeDasharray="3 4"/>)}
        {variantVisible && <line x1={x(variantPosition!)} x2={x(variantPosition!)} y1={panel.countY + 30} y2={panel.alternateBase} stroke="#9aa9be" strokeDasharray="2 4"><title>{`${variant} · genomic index ${variantPosition} (0-based)`}</title></line>}
        {(['reference', 'alternate'] as const).map(allele => {
          const baseline = allele === 'reference' ? panel.referenceBase : panel.alternateBase, color = allele === 'reference' ? BLUE : CORAL;
          return <g key={allele}>
            <text x={left} y={baseline - 84} fontFamily={MONO} fontSize={10} fontWeight={500} fill={color}>{allele === 'reference' ? 'REFERENCE' : 'ALTERNATE'}</text>
            <line x1={left} x2={right} y1={baseline} y2={baseline} stroke={GRID}/>
            {panel.rows.map((row, rowIndex) => {
              const value = row[allele];
              const arcHeight = 20 + 41 * Math.sqrt((row.end - row.start) / spanMaximum) + rowIndex % 3 * 3;
              const arc = junctionArcGeometry(row, dataset.interval, left, right, baseline, arcHeight);
              const description = `${row.chromosome}:[${row.start}, ${row.end}) · 0-based, half-open · strand ${row.strand} · ${row.track} · reference: ${junctionValueLabel(row.reference)} · alternate: ${junctionValueLabel(row.alternate)} · ${panel.metadata.unit || 'Unit not provided'} · showing ${allele}${arc.continuations.length ? ' · endpoint beyond viewport' : ''}`;
              return <g key={junctionIdentity(row)} className="junction-target" tabIndex={0} role="img" aria-label={description} data-allele={allele} data-value={value === null ? 'missing' : String(value)}>
                <title>{description}</title>
                <g clipPath={`url(#${clip})`}>
                  <path className="junction-focus" d={arc.path} fill="none" stroke="#172b4d" strokeWidth={9} strokeDasharray="2 4"/>
                  <path d={arc.path} fill="none" stroke="transparent" strokeWidth={12} style={{ cursor: 'help' }}/>
                  {value !== null && value > 0 && <path data-signal-arc="true" d={arc.path} fill="none" stroke={color} strokeWidth={junctionStrokeWidth(value, panel.maximum)} strokeLinecap="round"/>}
                  {value === 0 && <circle data-zero="true" cx={arc.markerX} cy={arc.markerY} r={3.5} fill="white" stroke={color} strokeWidth={1.5}/>}
                  {value === null && <path data-missing="true" d={`M ${arc.markerX - 3.5} ${arc.markerY - 3.5} l 7 7 M ${arc.markerX - 3.5} ${arc.markerY + 3.5} l 7 -7`} stroke={MUTED} strokeWidth={1.5}/>}
                </g>
                {value !== null && value > 0 && arc.continuations.map(continuation => <path key={continuation.side} data-continuation={continuation.side} d={continuation.side === 'left' ? `M ${left + 5} ${continuation.y - 4} L ${left} ${continuation.y} L ${left + 5} ${continuation.y + 4}` : `M ${right - 5} ${continuation.y - 4} L ${right} ${continuation.y} L ${right - 5} ${continuation.y + 4}`} fill="none" stroke={color} strokeWidth={1.3}/>)}
              </g>;
            })}
          </g>;
        })}
        <text x={left} y={panel.alternateBase + 22} fontFamily={MONO} fontSize={9} fill={MUTED}>{dataset.interval.start.toLocaleString('en-US')}</text>
        <text x={right} y={panel.alternateBase + 22} textAnchor="end" fontFamily={MONO} fontSize={9} fill={MUTED}>{dataset.interval.end.toLocaleString('en-US')}</text>
        <Lines lines={panel.footLines} x={left} y={panel.footY} size={8.5} fill={MUTED}/>
      </g>;
    })}
    <Lines lines={footer} x={left} y={offset} size={9} fill={INK}/>
  </svg>;
}
