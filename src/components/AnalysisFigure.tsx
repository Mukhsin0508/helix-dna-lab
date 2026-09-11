import { useEffect, useRef, useState, type Ref } from 'react';
import type { AnalysisDataset, ScoreRow } from '../../shared/analysis';
import type { FigureSettings } from '../../shared/analysis-record';
import { binnedSignalPath, featureKey, featureLabel, formatScore, matchingRows, rankedRows, rowLabel, scoreValue, signalMetadataLabel, signalUnit, trackGroups, unitLabel } from '../analysisUtils';

const INK = '#506581', GRID = '#e8edf4', BLUE = '#365fd7', CORAL = '#d56b61', MONO = 'IBM Plex Mono, ui-monospace, monospace';
interface Props { dataset: AnalysisDataset; settings: FigureSettings; svgRef: Ref<SVGSVGElement>; onSelect: (row: ScoreRow | null) => void }
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null); const [width, setWidth] = useState(900);
  useEffect(() => { if (!ref.current) return; const observer = new ResizeObserver(entries => setWidth(Math.max(310, entries[0].contentRect.width))); observer.observe(ref.current); return () => observer.disconnect(); }, []);
  return [ref, width];
}
function wrappedLines(text: string, width: number, fontSize: number): string[] {
  const words = text.split(' '), capacity = Math.max(1, Math.floor(width / (fontSize * .6))); const lines: string[] = []; let line = '';
  for (let word of words) {
    if (line && line.length + word.length + 1 > capacity) { lines.push(line); line = ''; }
    while (word.length > capacity) { lines.push(word.slice(0, capacity)); word = word.slice(capacity); }
    line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  return lines;
}
function WrapText({ text, x, y, width, fontSize = 10, fill = INK }: { text: string; x: number; y: number; width: number; fontSize?: number; fill?: string }) {
  const lines = wrappedLines(text, width, fontSize);
  return <text x={x} y={y} fontFamily={MONO} fontSize={fontSize} fill={fill}>{lines.map((value, index) => <tspan key={index} x={x} dy={index ? fontSize * 1.7 : 0}>{value}</tspan>)}</text>;
}
export default function AnalysisFigure({ dataset, settings, svgRef, onSelect }: Props) {
  const [wrapper, measured] = useWidth();
  const width = Math.round(measured), mobile = width < 570;
  const matching = matchingRows(dataset, settings);
  const ranked = rankedRows(dataset, settings);
  if (dataset.kind === 'tracks') {
    const groups = trackGroups(dataset.rows, dataset.trackMetadata).filter(group => !settings.track || group.key === settings.track).slice(0, settings.limit);
    const left = mobile ? 49 : 75, right = width - 32, labelWidth = right - left;
    let offset = 18;
    const panels = groups.map(group => {
      const title = wrappedLines(group.label, labelWidth, 11);
      const unit = `${group.metadata?.outputType || 'Output type unspecified'} · ${signalUnit(group.metadata)}`;
      const detail = signalMetadataLabel(group.metadata);
      const unitY = offset + title.length * 18;
      const detailY = unitY + wrappedLines(unit, labelWidth, 9).length * 15;
      const top = detailY + wrappedLines(detail, labelWidth, 8).length * 14 + 14;
      const panel = { group, labelY: offset, unit, unitY, detail, detailY, top };
      offset = top + 153;
      return panel;
    });
    const height = Math.max(330, offset + 30);
    return <div ref={wrapper}><svg ref={svgRef} className="plot-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${settings.title}. Reference and alternate tracks. Zero-based genomic positions.`}>
      <rect width={width} height={height} fill="white" />
      {panels.map(({ group, labelY, unit, unitY, detail, detailY, top }) => {
        const bottom = top + 95, binSize = group.metadata?.binSize;
        const minPos = group.rows[0].position, maxPos = group.rows[group.rows.length - 1].position + (binSize || 0);
        const minValue = Math.min(0, ...group.rows.flatMap(row => [row.reference, row.alternate]));
        const maxValue = Math.max(0, ...group.rows.flatMap(row => [row.reference, row.alternate])); const span = maxValue - minValue || 1;
        const px = (position: number): number => left + (position - minPos) / (maxPos - minPos || 1) * (right - left);
        const py = (value: number): number => bottom - (value - minValue) / span * (bottom - top);
        return <g key={group.key}>
          <WrapText text={group.label} x={left} y={labelY} width={labelWidth} fontSize={11}/>
          <WrapText text={unit} x={left} y={unitY} width={labelWidth} fontSize={9}/>
          <WrapText text={detail} x={left} y={detailY} width={labelWidth} fontSize={8} fill="#8191a7"/>
          {[0, .5, 1].map(t => <g key={t}><line x1={left} x2={right} y1={top + t * (bottom - top)} y2={top + t * (bottom - top)} stroke={GRID} /><text x={left - 10} y={top + t * (bottom - top) + 3} fill="#91a0b5" textAnchor="end" fontFamily={MONO} fontSize={8}>{formatScore(maxValue - t * span)}</text></g>)}
          {(['reference', 'alternate'] as const).map(kind => <g key={kind}>
            {binSize && <path d={binnedSignalPath(group.rows, kind, binSize, px, py)} fill="none" stroke={kind === 'reference' ? BLUE : CORAL} strokeWidth={1.8}/>}
            {(!binSize || group.rows.length < 40) && group.rows.map(row => <circle key={row.position} cx={px(row.position + (binSize ? binSize / 2 : 0))} cy={py(row[kind])} r={group.rows.length < 40 ? 2.4 : 1.2} fill={kind === 'reference' ? BLUE : CORAL}><title>{binSize ? `${group.label} · bin [${row.position}, ${row.position + binSize}) (0-based) · ${kind}: ${row[kind]} · ${signalUnit(group.metadata)}` : `${group.label} · position ${row.position} (0-based) · ${kind}: ${row[kind]}`}</title></circle>)}
          </g>)}
          <text x={left} y={bottom + 21} fontFamily={MONO} fontSize={9} fill="#8f9db1">{minPos.toLocaleString('en-US')}</text><text x={right} y={bottom + 21} textAnchor="end" fontFamily={MONO} fontSize={9} fill="#8f9db1">{maxPos.toLocaleString('en-US')}</text>
        </g>;
      })}
      <text x={width / 2} y={height - 18} textAnchor="middle" fill="#8090a7" fontFamily={MONO} fontSize={9}>Genomic position · 0-based · {dataset.provenance.assembly}</text>
    </svg></div>;
  }
  if (!matching.length) return <div ref={wrapper} className="empty-state"><h3>No matching scores</h3><p>Choose another gene, variant or track. Missing results are not treated as zero.</p></div>;
  if (settings.chart === 'heatmap') {
    const allVariants = [...new Set(ranked.map(row => row.variant))];
    const variants = allVariants.slice(0, 12);
    const cellIndex = new Map<string, ScoreRow[]>();
    for (const row of matching) { const cell = JSON.stringify([featureKey(row), row.variant]); cellIndex.set(cell, [...(cellIndex.get(cell) || []), row]); }
    const keys = [...new Set(ranked.map(featureKey))].slice(0, settings.limit);
    const left = mobile ? 110 : 180, right = width - 25, top = 55, cellHeight = mobile ? 36 : 31;
    const gridWidth = Math.max(right - left, variants.length * 65), actualWidth = left + gridWidth + 25;
    const height = top + keys.length * cellHeight + 110;
    const max = Math.max(...matching.map(row => Math.abs(scoreValue(row, settings.metric) || 0)), .0000001);
    return <div ref={wrapper} style={{ overflowX: 'auto' }}><svg ref={svgRef} className="plot-svg matrix-svg" style={{ minWidth: actualWidth }} viewBox={`0 0 ${actualWidth} ${Math.max(340, height)}`} role="img" aria-label={`${settings.title}. Variant by feature heatmap. Missing cells are hatched.`}>
      <defs><pattern id="no-score" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#f8fafc"/><path d="M0 6L6 0" stroke="#e3e9f1" strokeWidth="1"/></pattern></defs>
      <rect width={actualWidth} height={Math.max(340, height)} fill="white"/>
      <text x={left} y={25} fill="#8494ab" fontFamily={MONO} fontSize={9}>{keys.length} features · {variants.length}/{allVariants.length} variants · no aggregation</text>
      {keys.map((key, iy) => {
        const feature = matching.find(row => featureKey(row) === key)!;
        return <g key={key}><text x={left - 12} y={top + iy * cellHeight + cellHeight / 2 + 3} textAnchor="end" fontSize={10} fill={INK} fontFamily={MONO}>{featureLabel(feature).slice(0, mobile ? 12 : 22)}</text>
          {variants.map((variant, ix) => {
            const cells = cellIndex.get(JSON.stringify([key, variant])) || []; const row = cells.length === 1 ? cells[0] : undefined;
            const value = row ? scoreValue(row, settings.metric) : undefined;
            const cx = left + ix * gridWidth / variants.length, cy = top + iy * cellHeight, cw = gridWidth / variants.length - 3;
            return <g key={variant} onClick={() => onSelect(row || null)} style={{ cursor: row ? 'pointer' : 'default' }}>
              <rect x={cx} y={cy} width={cw} height={cellHeight - 3} rx={2} fill={value === undefined ? 'url(#no-score)' : value < 0 ? BLUE : CORAL} fillOpacity={value === undefined ? 1 : .08 + Math.abs(value) / max * .85}/>
              <text x={cx + cw / 2} y={cy + cellHeight / 2 + 2} textAnchor="middle" fontFamily={MONO} fontSize={9} fill={value !== undefined && Math.abs(value) / max > .6 ? '#fff' : '#586e91'}>{value === undefined ? cells.length > 1 ? 'Multiple' : '—' : formatScore(value)}</text>
              <title>{`${variant} · ${featureLabel(feature)} · ${value === undefined ? cells.length > 1 ? 'Multiple source rows. Use the data table; not aggregated.' : 'No supplied result' : `${settings.metric}: ${value}`}`}</title>
            </g>;
          })}
        </g>;
      })}
      {variants.map((variant, ix) => <g key={variant}><text x={left + (ix + .5) * gridWidth / variants.length} y={top + keys.length * cellHeight + 24} textAnchor="middle" fontFamily={MONO} fontSize={mobile ? 8 : 9} fill="#7185a2">{variant.split(':').slice(0, 2).join(':')}</text><text x={left + (ix + .5) * gridWidth / variants.length} y={top + keys.length * cellHeight + 41} textAnchor="middle" fontFamily={MONO} fontSize={9} fill="#7185a2">{variant.split(':')[2]}</text></g>)}
      <WrapText x={left} y={height - 22} width={gridWidth} fontSize={9} text={unitLabel(matching, settings)} fill="#8a9ab0"/>
    </svg></div>;
  }
  const visible = ranked.slice(0, settings.limit); const left = mobile ? 27 : Math.min(280, width * .30), right = width - (mobile ? 29 : 65);
  const rowHeight = mobile ? 74 : Math.max(45, Math.min(67, 320 / visible.length));
  const top = mobile ? 58 : 62, height = Math.max(360, top + visible.length * rowHeight + 94);
  const signed = matching[0]?.signed !== false || settings.metric === 'quantile';
  const extreme = Math.max(...matching.map(row => Math.abs(scoreValue(row, settings.metric) || 0)), 1e-9) * 1.12;
  const min = signed ? -extreme : 0, max = extreme;
  const px = (value: number): number => left + (value - min) / (max - min) * (right - left); const zero = px(0);
  const ticks = signed ? [-1, -.5, 0, .5, 1] : [0, .25, .5, .75, 1];
  const axisBottom = top + visible.length * rowHeight;
  return <div ref={wrapper}><svg ref={svgRef} className="plot-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${settings.title}. ${visible.length} of ${matching.length} matching scores, ranked by absolute magnitude. ${unitLabel(matching, settings)}.`}>
    <rect width={width} height={height} fill="white" />
    <text x={mobile ? left : 32} y={25} fontFamily={MONO} fill="#95a3b8" fontSize={8.5}>{mobile ? 'VARIANT / GENE' : 'VARIANT / GENE'}</text>
    {!mobile && <text x={right} y={25} fontFamily={MONO} fill="#95a3b8" fontSize={8.5} textAnchor="end">{settings.metric === 'score' ? 'RAW EFFECT SCORE' : 'QUANTILE SCORE'}</text>}
    {ticks.map(tick => <g key={tick}><line x1={px(tick * extreme)} x2={px(tick * extreme)} y1={top - 10} y2={axisBottom + 4} stroke={tick === 0 ? '#bdcce0' : GRID} strokeDasharray={tick === 0 ? undefined : '3 4'}/><text x={px(tick * extreme)} y={axisBottom + 27} textAnchor="middle" fill="#8b9bb2" fontFamily={MONO} fontSize={9}>{formatScore(tick * extreme)}</text></g>)}
    {visible.map((row, index) => {
      const value = scoreValue(row, settings.metric)!; const y = top + index * rowHeight; const barY = y + (mobile ? 23 : 1), barH = mobile ? 17 : 23;
      const valueX = value >= 0 ? px(value) + 7 : px(value) - 7;
      return <g key={`${row.variant}:${featureKey(row)}:${row.sourceRowIndex ?? index}`} onClick={() => onSelect(row)} style={{ cursor: 'pointer' }}>
        <title>{`${rowLabel(row)} · ${row.scorer} · ${settings.metric}: ${value}`}</title>
        <rect x={0} y={y - 18} width={width} height={rowHeight} fill="transparent"/>
        <text x={mobile ? left : left - 23} y={y + (mobile ? 8 : row.gene ? 6 : 17)} fontSize={mobile ? 9 : 10.5} fontFamily={MONO} textAnchor={mobile ? 'start' : 'end'} fill={INK}>{row.gene || row.variant}</text>
        {row.gene && <text x={mobile ? left + 95 : left - 23} y={y + (mobile ? 8 : 22)} fontSize={8.5} fontFamily={MONO} textAnchor={mobile ? 'start' : 'end'} fill="#9aa8ba">{row.variant}</text>}
        <rect x={Math.min(zero, px(value))} y={barY} width={Math.abs(px(value) - zero)} height={barH} rx={2} fill={value < 0 ? BLUE : CORAL}/>{value === 0 && <circle cx={zero} cy={barY + barH / 2} r={2} fill="#a0afc3"/>}
        <text x={valueX} y={barY + barH / 2 + 3} textAnchor={value >= 0 ? 'start' : 'end'} fontFamily={MONO} fontSize={mobile ? 8 : 9.5} fill={value < 0 ? BLUE : CORAL}>{formatScore(value)}</text>
      </g>;
    })}
    <WrapText x={left} y={axisBottom + 55} width={right - left} text={unitLabel(matching, settings)} fontSize={mobile ? 8 : 9} fill="#8697af"/>
  </svg></div>;
}
