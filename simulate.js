// The 2,000-day simulation of the emergency department.
// A line-by-line copy of simulate() and calibrate_div_share() in model/engine.py.
(function (root) {
  const SHIFTS = ["Morning", "Evening", "Night"];
  const STAFF = ["Doctor", "Nurse", "Technician"];
  const COL = ["morning", "evening", "night"];
  const TAG = { Doctor: "doctor", Nurse: "nurse", Technician: "tech" };

  // Inverse of the normal distribution (Wichura, algorithm AS241). Same accuracy as scipy's norm.ppf.
  function ppnd16(p) {
    const q = p - 0.5;
    let r, val;
    if (Math.abs(q) <= 0.425) {
      r = 0.180625 - q * q;
      return q * (((((((r * 2509.0809287301226727 + 33430.575583588128105) * r + 67265.770927008700853) * r +
        45921.953931549871457) * r + 13731.693765509461125) * r + 1971.5909503065514427) * r +
        133.14166789178437745) * r + 3.387132872796366608) /
        (((((((r * 5226.495278852545925 + 28729.085735721942674) * r + 39307.89580009271061) * r +
        21213.794301586595867) * r + 5394.1960214247511077) * r + 687.1870074920579083) * r +
        42.313330701600911252) * r + 1.0);
    }
    r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p));
    if (r <= 5) {
      r -= 1.6;
      val = (((((((r * 7.7454501427834140764e-4 + 0.0227238449892691845833) * r + 0.24178072517745061177) * r +
        1.27045825245236838258) * r + 3.64784832476320460504) * r + 5.7694972214606914055) * r +
        4.6303378461565452959) * r + 1.42343711074968357734) /
        (((((((r * 1.05075007164441684324e-9 + 5.475938084995344946e-4) * r + 0.0151986665636164571966) * r +
        0.14810397642748007459) * r + 0.68976733498510000455) * r + 1.6763848301838038494) * r +
        2.05319162663775882187) * r + 1.0);
    } else {
      r -= 5;
      val = (((((((r * 2.01033439929228813265e-7 + 2.71155556874348757815e-5) * r + 0.0012426609473880784386) * r +
        0.026532189526576123093) * r + 0.29656057182850489123) * r + 1.7848265399172913358) * r +
        5.4637849111641143699) * r + 6.6579046435011037772) /
        (((((((r * 2.04426310338993978564e-15 + 1.4215117583164458887e-7) * r + 1.8463183175100546818e-5) * r +
        7.868691311456732916e-4) * r + 0.0148753612908506148525) * r + 0.13692988092273580531) * r +
        0.59983220655588793769) * r + 1.0);
    }
    return q < 0 ? -val : val;
  }

  // How many of n rostered staff turn up: smallest k with P(X <= k) >= u, X ~ Binomial(n, p).
  function binomInv(u, n, p) {
    if (p <= 0) return 0;
    if (p >= 1) return n;
    const q = 1 - p;
    let pmf = Math.pow(q, n), cdf = pmf;
    for (let k = 0; k < n; k++) {
      if (cdf >= u) return k;
      pmf *= ((n - k) / (k + 1)) * (p / q);
      cdf += pmf;
    }
    return n;
  }

  const idx = (j, r) => j * 3 + r;

  function plannedCost(plan, P) {
    let cost = 0;
    for (let j = 0; j < 3; j++) {
      for (let r = 0; r < 3; r++) {
        cost += P.REG[STAFF[r]] * plan.R[idx(j, r)] + P.OT[STAFF[r]] * plan.O[idx(j, r)];
      }
    }
    return cost + P.BED_COST * (plan.beds - P.BED_BASE) + P.IMG_COST * plan.img + P.LAB_COST * plan.lab;
  }

  function arrivals(U, P, i, j, muMult, incP, incUp) {
    const s = SHIFTS[j];
    const inc = U.u_incident[i] < incP && Math.floor(U.u_incident_shift[i] * 3) === j;
    const f = inc ? 1 + incUp : 1.0;
    const mean = P.MU[s] * muMult * f, sd = P.SD[s] * muMult * f;
    return Math.max(0, Math.floor(mean + sd * ppnd16(U["u_arr_" + COL[j]][i]) + 0.5));
  }

  function bedHours(U, P, i, j) {
    return P.BH[SHIFTS[j]] * (1 - P.BH_VAR + 2 * P.BH_VAR * U["u_bedhrs_" + COL[j]][i]);
  }

  // Today's 5.2 diversions a day are assumed to come from bed overflow at 34 beds.
  function calibrate(P, U) {
    const n = U.u_casemix.length;
    let total = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 3; j++) {
        const A = arrivals(U, P, i, j, 1, P.INC_P, P.INC_UP);
        total += Math.max(0, A - P.BED_BASE * P.SHIFT_HRS / bedHours(U, P, i, j));
      }
    }
    return P.DIV_TODAY / (total / n);
  }

  // o: { share, muMult, absMult, incP, otCap, unavailable: {"Doctor|Evening": 1} }
  function simulate(plan, P, U, o) {
    const n = U.u_casemix.length;
    const muMult = o.muMult ?? 1, absMult = o.absMult ?? 1, incP = o.incP ?? P.INC_P, otCap = o.otCap ?? P.OT_CAP;
    const unavailable = o.unavailable || {};
    const A = new Float64Array(n * 3), div = new Float64Array(n * 3), board = new Float64Array(n * 3);
    const uncov = new Float64Array(n * 3), served = new Float64Array(n * 3);
    const surgeCost = new Float64Array(n * 3), surgeStaff = new Float64Array(n * 3);

    for (let j = 0; j < 3; j++) {
      const s = SHIFTS[j];
      const docWeight = 1 + (P.HA_MULT - 1) * P.HA[s];
      const rostered = [], room = [], presentProb = [], absCol = [];
      for (let r = 0; r < 3; r++) {
        const R = plan.R[idx(j, r)], O = plan.O[idx(j, r)];
        rostered.push(Math.max(0, R + O - (unavailable[STAFF[r] + "|" + s] || 0)));
        room.push(Math.max(0, Math.floor(otCap * R + 1e-9) - O));
        presentProb.push(1 - Math.min(1, P.ABS[STAFF[r]] * absMult));
        absCol.push(U["u_abs_" + TAG[STAFF[r]] + "_" + COL[j]]);
      }
      for (let i = 0; i < n; i++) {
        const cmu = U.u_casemix[i];
        const cf = cmu < 0.70 ? 1.0 : cmu < 0.90 ? 0.9 : 0.8;
        const a = arrivals(U, P, i, j, muMult, incP, P.INC_UP);
        const bh = bedHours(U, P, i, j);
        const over = Math.max(0, a - plan.beds * P.SHIFT_HRS / bh);
        const d = o.share * over;
        const retained = a - d;
        let cap = Infinity, cost = 0, staffAdded = 0;
        for (let r = 0; r < 3; r++) {
          const present = rostered[r] > 0 ? binomInv(absCol[r][i], rostered[r], presentProb[r]) : 0;
          const per = P.PROD[STAFF[r]] * cf / (r === 0 ? docWeight : 1.0);
          const need = Math.ceil(retained / per - 1e-9);
          const add = Math.min(Math.max(need - present, 0), room[r]);
          cost += add * P.OT[STAFF[r]];
          staffAdded += add;
          cap = Math.min(cap, (present + add) * per);
        }
        const u = Math.max(0, retained - cap);
        const k = i * 3 + j;
        A[k] = a; div[k] = d; board[k] = (1 - o.share) * over * bh; uncov[k] = u;
        served[k] = a - d - u; surgeCost[k] = cost; surgeStaff[k] = staffAdded;
      }
    }

    const planned = plannedCost(plan, P);
    const plannedOtShift = [0, 1, 2].map(j => (plan.O[idx(j, 0)] + plan.O[idx(j, 1)] + plan.O[idx(j, 2)]) > 0);
    let total = 0, divDay = 0, uncovDay = 0, servedAll = 0, arrivedAll = 0, goodDays = 0, otMulti = 0, surgeAll = 0;
    const uncovShift = [0, 0, 0], divShift = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      let pen = 0, surge = 0, good = true, otShifts = 0;
      for (let j = 0; j < 3; j++) {
        const k = i * 3 + j;
        pen += P.PEN_UNCOV * uncov[k] + P.PEN_DIV * div[k] + P.PEN_BEDHR * board[k];
        surge += surgeCost[k];
        divDay += div[k]; uncovDay += uncov[k]; servedAll += served[k]; arrivedAll += A[k];
        uncovShift[j] += uncov[k]; divShift[j] += div[k];
        if (served[k] / Math.max(A[k], 1) < P.TARGET) good = false;
        if (surgeStaff[k] > 0 || plannedOtShift[j]) otShifts++;
      }
      total += planned + surge + pen;
      surgeAll += surge;
      if (good) goodDays++;
      if (otShifts > 1) otMulti++;
    }
    return {
      planned_cost: planned, exp_total: total / n, exp_surge_ot: surgeAll / n,
      exp_div: divDay / n, exp_uncov: uncovDay / n, coverage: servedAll / arrivedAll,
      p_target_day: goodDays / n, p_ot_multi: otMulti / n,
      uncov_by_shift: uncovShift.map(x => x / n), div_by_shift: divShift.map(x => x / n),
    };
  }

  const api = { SHIFTS, STAFF, simulate, calibrate, plannedCost, idx };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.MC = api;
})(typeof window !== "undefined" ? window : globalThis);
