import type { JunctionRow } from '../../shared/analysis';
import { junctionIdentity, junctionValueLabel } from '../junctionUtils';

/** Exact supplied allele values; a missing junction is not a zero-count junction. */
export default function JunctionTable({ rows, limit = 100 }: { rows: JunctionRow[]; limit?: number }) {
  return <div className="table-scroll"><table className="data-table"><thead><tr>
    <th>Chromosome</th><th>Start · 0-based</th><th>End · exclusive</th><th>Strand</th><th>Reference</th><th>Alternate</th><th>ALT − REF</th><th>Track</th>
  </tr></thead><tbody>{rows.slice(0, limit).map(row => <tr key={junctionIdentity(row)}>
    <td>{row.chromosome}</td><td>{row.start}</td><td>{row.end}</td><td>{row.strand}</td><td>{junctionValueLabel(row.reference)}</td><td>{junctionValueLabel(row.alternate)}</td>
    <td>{row.reference === null || row.alternate === null ? 'Not available' : String(row.alternate - row.reference)}</td><td>{row.track}</td>
  </tr>)}</tbody></table></div>;
}
