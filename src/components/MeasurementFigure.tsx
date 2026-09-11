import type { Ref } from 'react';
import type { MeasurementDataset } from '../../shared/analysis';
import type { FigureSettings } from '../../shared/analysis-record';
import { formatScore, matchingMeasurements, measurementAggregation, measurementValue } from '../analysisUtils';

interface Props { dataset: MeasurementDataset; settings: FigureSettings; width: number; svgRef: Ref<SVGSVGElement> }
const BLUE = '#365fd7', MONO = 'IBM Plex Mono, ui-monospace, monospace';

/** Source measurements and optional supplied standard errors; no predictions or inferred uncertainty. */
export default function MeasurementFigure({ dataset, settings, width, svgRef }: Props) {
  const matching = matchingMeasurements(dataset, settings), rows = matching.slice(0, settings.limit), mobile = width < 570;
  if (!rows.length) return <div className="empty-state"><h3>No matching measurements</h3><p>Choose another gene or variant.</p></div>;
  const left = mobile ? 28 : Math.min(255, width * .31), right = width - (mobile ? 45 : 65);
  const rowHeight = mobile ? 70 : 47, top = 59, height = Math.max(370, top + rows.length * rowHeight + 105);
  const lower = Math.min(0, ...matching.map(row => row.value - (row.standardError ?? 0)));
  const upper = Math.max(dataset.experiment.unit === 'fraction' ? 1 : dataset.experiment.unit === 'percent' ? 100 : 0, ...matching.map(row => row.value + (row.standardError ?? 0)));
  const min = lower, max = upper === lower ? upper + 1 : upper;
  const x = (value: number): number => left + (value - min) / (max - min) * (right - left);
  const axisBottom = top + rows.length * rowHeight;
  const suppliedSE = rows.some(row => row.standardError !== null);
  const axisLabel = `${dataset.experiment.unitLabel} · ${dataset.experiment.unit}`;
  return <svg ref={svgRef} className="plot-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${settings.title}. ${rows.length} of ${matching.length} experimental measurements in source order. ${axisLabel}. ${suppliedSE ? 'Error bars show supplied standard errors.' : 'Uncertainty not supplied.'}`}>
    <rect width={width} height={height} fill="white"/>
    <text x={mobile ? left : 32} y={24} fill="#95a3b8" fontFamily={MONO} fontSize={8.5}>VARIANT · 1-BASED</text>
    {!mobile && <text x={right} y={24} fill="#95a3b8" textAnchor="end" fontFamily={MONO} fontSize={8.5}>MEASURED VALUE</text>}
    {[0, .25, .5, .75, 1].map(tick => <g key={tick}><line x1={x(min + tick * (max - min))} x2={x(min + tick * (max - min))} y1={top - 15} y2={axisBottom} stroke="#e3eaf3" strokeDasharray={tick === 0 ? undefined : '3 4'}/><text x={x(min + tick * (max - min))} y={axisBottom + 22} textAnchor="middle" fill="#8294ad" fontFamily={MONO} fontSize={9}>{formatScore(min + tick * (max - min))}</text></g>)}
    {rows.map((row, index) => {
      const labelY = top + index * rowHeight, y = labelY + (mobile ? 27 : 5);
      const exact = measurementValue(row);
      return <g key={row.variant}>
        <title>{`${row.variant} · ${row.gene || 'Gene not provided'} · measured ${dataset.experiment.endpoint}: ${exact} ${dataset.experiment.unit} · ${measurementAggregation(dataset)} · replicates: ${row.replicates ?? 'not reported'} · standard error: ${row.standardError ?? 'not reported'}`}</title>
        <text x={mobile ? left : left - 22} y={labelY + 8} textAnchor={mobile ? 'start' : 'end'} fill="#536986" fontFamily={MONO} fontSize={mobile ? 9 : 10}>{row.variant}</text>
        <line x1={x(Math.max(min, 0))} x2={x(row.value)} y1={y} y2={y} stroke="#c4d2f2" strokeWidth={2}/>
        {row.standardError !== null && <g stroke={BLUE} strokeWidth={1.4} aria-label="Reported standard error"><line x1={x(row.value - row.standardError)} x2={x(row.value + row.standardError)} y1={y} y2={y}/><line x1={x(row.value - row.standardError)} x2={x(row.value - row.standardError)} y1={y - 5} y2={y + 5}/><line x1={x(row.value + row.standardError)} x2={x(row.value + row.standardError)} y1={y - 5} y2={y + 5}/></g>}
        <circle cx={x(row.value)} cy={y} r={4.5} fill={BLUE} stroke="white" strokeWidth={1.2}/>
        <text x={x(row.value + (row.standardError ?? 0)) + 10} y={y + 3} fill={BLUE} fontFamily={MONO} fontSize={10}>{exact}</text>
      </g>;
    })}
    <text x={width / 2} y={axisBottom + 48} textAnchor="middle" fill="#657b9c" fontFamily={MONO} fontSize={mobile ? 8 : 9}>{mobile ? dataset.experiment.unit : axisLabel}</text>
    <text x={width / 2} y={axisBottom + 72} textAnchor="middle" fill="#94a1b4" fontFamily={MONO} fontSize={mobile ? 7.5 : 8.5}>{suppliedSE ? 'Error bars: supplied SE only' : 'Replicate counts and uncertainty are not imputed'}</text>
  </svg>;
}
