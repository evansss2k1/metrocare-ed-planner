// Checks that the web page's numbers match the Excel model (baseline_results.json).
// Run from the MetroCare-DSS folder:  node model/tests/check_web.js
globalThis.window = globalThis;
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
for (const f of ["params", "days", "plans", "baseline"]) require(path.join(ROOT, "data", f + ".js"));
const MC = require(path.join(ROOT, "simulate.js"));

const P = window.MC_PARAMS, U = window.MC_DAYS, BASE = window.MC_BASELINE, PLANS = window.MC_PLANS["0|25"];
let failures = 0;
function check(label, got, want, tol, relative) {
  const diff = relative ? Math.abs(got - want) / Math.abs(want) : Math.abs(got - want);
  const ok = diff <= tol;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got.toFixed(4)} (Excel ${want.toFixed(4)})`);
}

const share = MC.calibrate(P, U);
check("diversion share", share, 0.34771757438485074, 1e-9, true);

const plans = { A: PLANS.A, B: PLANS.B, C: PLANS.C, D: P.D };
for (const k of ["A", "B", "C", "D"]) {
  const r = MC.simulate(plans[k], P, U, { share });
  const b = BASE[k];
  check(`${k} planned cost`, r.planned_cost, b.planned_cost, 0.005, true);
  check(`${k} expected cost`, r.exp_total, b.exp_total, 0.005, true);
  check(`${k} coverage`, r.coverage, b.coverage, 0.002, false);
  check(`${k} diversions/day`, r.exp_div, b.exp_div, 0.005, true);
  check(`${k} uncovered/day`, r.exp_uncov, b.exp_uncov, 0.005, true);
  check(`${k} good days`, r.p_target_day, b.p_target_day, 0.002, false);
  check(`${k} overtime in >1 shift`, r.p_ot_multi, b.p_ot_multi, 0.002, false);
}
const short = MC.simulate(P.D, P, U, { share, unavailable: { "Doctor|Evening": 1 } });
check("D with 1 evening doctor missing", short.exp_total, 432895, 0.005, true);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
