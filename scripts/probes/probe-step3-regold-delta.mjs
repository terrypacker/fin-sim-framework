/**
 * Step 3's re-gold, read in ABSOLUTE terms before it is committed (design 94 §9.5a).
 *
 * The spike's biggest relative move was 6.1e-1 and it was $0.01 on a residual of $0.016.
 * Several near-zero dust fields will show enormous relative moves here for the same
 * reason, so this prints the absolute column first and the relative column second.
 */
import { GOLDEN_SPECS } from '../../tests/helpers/golden-specs.js';
import { runGolden, readFixture, normalizeState } from '../../tests/helpers/golden-harness.js';

const flat = (v, prefix = '', out = {}) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) flat(x, prefix ? `${prefix}.${k}` : k, out);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => flat(x, `${prefix}[${i}]`, out));
  } else out[prefix] = v;
  return out;
};

let totalNew = 0, totalMoved = 0, worstAbs = 0, worstAbsKey = '';
for (const spec of GOLDEN_SPECS) {
  const before = flat(readFixture(spec.name) ?? {});
  const after  = flat(normalizeState(runGolden(spec).state));
  const added = [], moved = [];
  for (const k of Object.keys(after)) {
    if (!(k in before)) { added.push(k); continue; }
    if (before[k] === after[k]) continue;
    const a = Number(before[k]), b = Number(after[k]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const abs = Math.abs(b - a);
      moved.push({ k, from: a, to: b, abs, rel: a === 0 ? Infinity : abs / Math.abs(a) });
    } else moved.push({ k, from: before[k], to: after[k], abs: NaN, rel: NaN });
  }
  const dropped = Object.keys(before).filter(k => !(k in after));
  moved.sort((x, y) => y.abs - x.abs);
  const byKind = {};
  for (const k of added) {
    const leaf = k.split('.').pop().replace(/\[\d+\]$/, '');
    byKind[leaf] = (byKind[leaf] ?? 0) + 1;
  }
  totalNew += added.length; totalMoved += moved.length;
  if (moved[0]?.abs > worstAbs) { worstAbs = moved[0].abs; worstAbsKey = `${spec.name}:${moved[0].k}`; }
  console.log(`\n── ${spec.name} — ${added.length} new field(s), ${moved.length} moved, ${dropped.length} dropped`);
  console.log(`   new: ${Object.entries(byKind).map(([k, n]) => `${k} x${n}`).join(', ') || '(none)'}`);
  if (dropped.length) console.log(`   DROPPED: ${dropped.slice(0, 8).join(', ')}${dropped.length > 8 ? ' …' : ''}`);
  for (const m of moved.slice(0, 8)) {
    console.log(`   |Δ| ${m.abs.toFixed(4).padStart(12)}  rel ${Number.isFinite(m.rel) ? m.rel.toExponential(1) : 'n/a '}  ${m.k}  ${m.from} → ${m.to}`);
  }
  if (moved.length > 8) console.log(`   … ${moved.length - 8} more, all smaller in absolute terms`);
}
console.log(`\nTOTAL: ${totalNew} new field(s), ${totalMoved} moved. Worst absolute move: ${worstAbs.toFixed(4)} at ${worstAbsKey}`);
