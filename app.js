// The screens. All maths is in simulate.js (simulation) and data/plans.js (plans solved by model/engine.py).
(function () {
  document.documentElement.classList.add("js");
  const P = window.MC_PARAMS, U = window.MC_DAYS, ALL_PLANS = window.MC_PLANS, MC = window.MC;
  const SHIFTS = MC.SHIFTS, STAFF = MC.STAFF;
  const SHARE = MC.calibrate(P, U);
  // The four rosters stay fixed, exactly as in the Excel Sensitivity sheet and the report: the controls change the
  // situation (patients, sick leave, emergencies, overtime room), not the plans. Only the absence fix is re-planned.
  const BASE = ALL_PLANS["0|25"];
  const PLANS = { D: P.D, A: BASE.A, B: BASE.B, C: BASE.C };
  const $ = id => document.getElementById(id);
  const SVG = "http://www.w3.org/2000/svg";

  const PLAN_INFO = {
    D: ["Recommended", "Enough staff in each shift, plus 44 beds", "#0F5257"],
    A: ["Cheapest", "Pay as little as possible for staff", "#9AA0A6"],
    B: ["Service-first", "Try to see everyone using lots of overtime", "#C9A66B"],
    C: ["Maximum safety", "Most staff and beds, plus extra scans and lab", "#5B7C8D"],
  };
  const ROLE_COL = ["#0F5257", "#C9A66B", "#5B7C8D"];
  const WORD = { Doctor: "doctor", Nurse: "nurse", Technician: "technician" };
  const PLURAL = { Doctor: "Doctors", Nurse: "Nurses", Technician: "Technicians" };
  const DEFAULTS = { extra: 0, ot: 25, sick: "1", emerg: "0.04" };

  const state = { shift: 1, absent: null, boardMsg: "" };   // absent = { r, j, marks: [token indexes] }

  // ---------------------------------------------------------------- helpers
  const money = x => "₹" + Math.round(x).toLocaleString("en-US");
  const signed = x => (x < 0 ? "−" : "+") + money(Math.abs(x));
  const pct = (x, d = 1) => (x * 100).toFixed(d) + "%";
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const people = (n, staff) => `${n} ${WORD[staff]}${n === 1 ? "" : "s"}`;
  const onShift = (plan, j, r) => plan.R[MC.idx(j, r)] + plan.O[MC.idx(j, r)];
  const totalOf = (plan, r) => onShift(plan, 0, r) + onShift(plan, 1, r) + onShift(plan, 2, r);
  const FMT = { money, pct1: x => pct(x, 1), pct0: x => pct(x, 0), dec1: x => x.toFixed(1), int: x => String(Math.round(x)) };

  // Last shown value of every animated number, bar and ring, so changes animate from where they were.
  const shown = {};

  function count(key, value, fmt) {
    const from = shown[key] ?? (fmt === "money" ? value * 0.9 : 0);
    return `<span class="count" data-key="${key}" data-from="${from}" data-to="${value}" data-fmt="${fmt}">${FMT[fmt](from)}</span>`;
  }

  function fill(key, width, cls) {
    return `<span class="bar-fill ${cls}" data-key="${key}" data-w="${width}" style="width:${shown[key] ?? 0}%"></span>`;
  }

  function ring(key, value) {
    return `<svg class="ring" viewBox="0 0 48 48" aria-hidden="true"><circle class="ring-track" cx="24" cy="24" r="20"/>` +
      `<circle class="ring-fill" cx="24" cy="24" r="20" data-key="${key}" data-dash="${value * 100}" style="stroke-dasharray:0 999"/></svg>`;
  }

  function animate() {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.querySelectorAll(".count").forEach(el => {
      const from = +el.dataset.from, to = +el.dataset.to, f = FMT[el.dataset.fmt];
      shown[el.dataset.key] = to;
      if (reduced || document.hidden || from === to) { el.textContent = f(to); return; }
      const start = performance.now(), duration = 700;
      const step = now => {
        const k = Math.min(1, (now - start) / duration), eased = 1 - Math.pow(1 - k, 3);
        el.textContent = f(from + (to - from) * eased);
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    // Bars, arcs and rings: reading the layout commits the old size, so the new size transitions without waiting for a frame.
    document.querySelectorAll("[data-w]").forEach(el => {
      shown[el.dataset.key] = +el.dataset.w;
      void el.offsetWidth;
      el.style.width = el.dataset.w + "%";
    });
    // Arcs and rings: data-dash is a percentage of the shape's real length (the pathLength attribute is not honoured by every browser).
    document.querySelectorAll("[data-dash]").forEach(el => {
      const L = el.getTotalLength(), key = el.dataset.key, to = +el.dataset.dash, from = shown[key] ?? 0;
      shown[key] = to;
      el.style.strokeDasharray = `${(from / 100) * L} ${L}`;
      void el.getBoundingClientRect();
      el.style.strokeDasharray = `${(to / 100) * L} ${L}`;
    });
  }

  function svgEl(tag, attrs, parent) {
    const node = document.createElementNS(SVG, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  // What limits a shift the most, in patients per shift
  function mainLimit(plan, j) {
    const s = SHIFTS[j];
    const limits = {
      doctors: onShift(plan, j, 0) * P.PROD.Doctor / (1 + (P.HA_MULT - 1) * P.HA[s]),
      nurses: onShift(plan, j, 1) * P.PROD.Nurse,
      technicians: onShift(plan, j, 2) * P.PROD.Technician,
      beds: plan.beds * P.SHIFT_HRS / P.BH[s],
    };
    const name = Object.keys(limits).reduce((a, b) => (limits[b] < limits[a] ? b : a));
    return { name, value: limits[name] };
  }

  const segValue = id => document.querySelector(`#${id} [aria-checked="true"]`).dataset.value;

  function settings() {
    const extra = +$("extra").value, ot = +$("ot").value;
    return {
      extra, ot, entry: ALL_PLANS[extra + "|" + ot],
      opts: { share: SHARE, muMult: 1 + extra / 100, absMult: +segValue("sick"), incP: +segValue("emerg"), otCap: ot / 100 },
    };
  }

  // ---------------------------------------------------------------- the 24-hour dial
  const DIAL = { c: 170, r: 118 };
  const polar = (deg, r) => {
    const a = (deg - 90) * Math.PI / 180;
    return [DIAL.c + r * Math.cos(a), DIAL.c + r * Math.sin(a)];
  };
  const arcPath = (a0, a1, r) => {
    const [x0, y0] = polar(a0, r), [x1, y1] = polar(a1, r);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  const levelOf = load => (load > 1 ? "over" : load >= 0.85 ? "tight" : "ok");

  function buildDial() {
    const svg = $("dial");
    for (let h = 0; h < 24; h++) {   // one tick per hour: three 8-hour shifts
      const [x0, y0] = polar(h * 15, DIAL.r - 30), [x1, y1] = polar(h * 15, DIAL.r - (h % 8 === 0 ? 20 : 24));
      svgEl("line", { x1: x0, y1: y0, x2: x1, y2: y1, class: "dial-tick" + (h % 8 === 0 ? " major" : "") }, svg);
    }
    SHIFTS.forEach((sh, j) => {
      const a0 = j * 120 + 3, a1 = (j + 1) * 120 - 3;
      const g = svgEl("g", { class: "arc", "data-j": j, tabindex: "0", role: "button" }, svg);
      svgEl("path", { d: arcPath(a0, a1, DIAL.r), class: "arc-track" }, g);
      svgEl("path", { d: arcPath(a0, a1, DIAL.r), class: "arc-fill", "data-key": "arc" + j }, g);
      const [lx, ly] = polar((a0 + a1) / 2, DIAL.r + 38);
      svgEl("text", { x: lx, y: ly, class: "arc-label", "text-anchor": "middle", "dominant-baseline": "middle" }, g).textContent = sh;
      const pick = () => { state.shift = j; renderAll(); };
      g.addEventListener("click", pick);
      g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    });
  }

  function updateDial(s, r) {
    const plan = PLANS.D;
    SHIFTS.forEach((sh, j) => {
      const load = P.MU[sh] * s.opts.muMult / mainLimit(plan, j).value;
      const g = $("dial").querySelector(`.arc[data-j="${j}"]`);
      g.dataset.level = levelOf(load);
      g.classList.toggle("selected", j === state.shift);
      g.setAttribute("aria-pressed", j === state.shift);
      g.setAttribute("aria-label", `${sh} shift: ${Math.round(load * 100)}% full on an average day. Show its team.`);
      g.querySelector(".arc-fill").dataset.dash = Math.min(load, 1) * 100;
    });

    const j = state.shift, sh = SHIFTS[j], lim = mainLimit(plan, j);
    const expected = P.MU[sh] * s.opts.muMult, load = expected / lim.value;
    $("dialCentre").innerHTML = `<span class="dc-kicker">${sh}</span>` +
      `<span class="dc-big lvl-${levelOf(load)}">${count("dial-load", load, "pct0")}</span>` +
      `<span class="dc-sub">full on an average day</span>`;

    $("shiftDetail").innerHTML = `<div class="shift-panel" data-j="${j}">` +
      `<div class="sp-head"><strong>${sh} team</strong><span>${Math.round(expected)} patients expected · room for ${Math.round(lim.value)}</span></div>` +
      `<div class="sp-staff">` +
      STAFF.map((st, k) => `<div class="sp-role" style="--c:${ROLE_COL[k]}"><b>${onShift(plan, j, k)}</b><span>${PLURAL[st]}</span></div>`).join("") +
      `<div class="sp-role"><b>${plan.beds}</b><span>Beds</span></div></div>` +
      `<p class="sp-foot">Main limit: <b>${lim.name}</b> · about ${r.uncov_by_shift[j].toFixed(1)} patients not seen and ` +
      `${r.div_by_shift[j].toFixed(1)} sent away in this shift a day</p></div>`;
  }

  // ---------------------------------------------------------------- the day, on average
  function renderVerdict(r) {
    const extra = r.exp_total - r.planned_cost;
    const stats = [
      { key: "v-cost", label: "Real cost per day", value: r.exp_total, fmt: "money",
        bar: fill("vb-w", r.planned_cost / r.exp_total * 100, "wages") + fill("vb-r", extra / r.exp_total * 100, "risk"),
        hint: `Wages and beds ${money(r.planned_cost)} + overtime and missed patients ${money(extra)}` },
      { key: "v-care", label: "Patients who get care", value: r.coverage, fmt: "pct1", bad: r.coverage < 0.95,
        bar: fill("vb-c", r.coverage * 100, "good"), hint: "out of everyone who arrives" },
      { key: "v-div", label: "Sent to another hospital", value: r.exp_div, fmt: "dec1", unit: "a day", bad: r.exp_div > 2,
        bar: fill("vb-d", Math.min(r.exp_div / 5.2, 1) * 100, "risk"), hint: "the bar is full at today's 5.2 a day" },
      { key: "v-good", label: "Good days", value: r.p_target_day, fmt: "pct0", bad: r.p_target_day < 0.5,
        bar: fill("vb-g", r.p_target_day * 100, "good"), hint: "every shift sees at least 95% of patients" },
    ];
    $("verdict").innerHTML = `<p class="card-kicker">The day, on average</p>` + stats.map((t, i) =>
      `<div class="tile stat${t.bad ? " bad" : ""}" style="--i:${i}"><div class="label">${t.label}</div>` +
      `<div class="value">${count(t.key, t.value, t.fmt)}${t.unit ? `<small>${t.unit}</small>` : ""}</div>` +
      `<div class="bar">${t.bar}</div><div class="hint">${t.hint}</div></div>`).join("");
  }

  function renderWords(res) {
    const r = res.D, a = res.A, plan = PLANS.D;
    const lost = [0, 1, 2].map(j => r.uncov_by_shift[j] + r.div_by_shift[j]);
    const hardest = lost.indexOf(Math.max(...lost));
    const points = [
      `Wages and beds cost ${money(r.planned_cost)} a day. Overtime and the cost of patients we cannot help add about ` +
      `${money(r.exp_total - r.planned_cost)}, so the real cost is ${money(r.exp_total)}.`,
      `About ${Math.round(r.coverage * 100)} out of every 100 patients get care, and about ${r.exp_div.toFixed(1)} ` +
      `patients a day are sent to another hospital (today it is 5.2).`,
      `The hardest shift is the ${SHIFTS[hardest].toLowerCase()}. What holds it back most is the number of ${mainLimit(plan, hardest).name}.`,
      a.exp_total > r.exp_total
        ? `The cheapest plan saves ${money(r.planned_cost - a.planned_cost)} on wages, but it misses so many patients that ` +
          `it really costs ${money(a.exp_total - r.exp_total)} more a day.`
        : "With these settings the cheapest plan is also the cheapest overall, so the extra staff may not be worth it.",
    ];
    $("simpleWords").innerHTML = `<h3>In simple words</h3><ul class="ticks">${points.map(p => `<li>${p}</li>`).join("")}</ul>`;
  }

  // ---------------------------------------------------------------- four plans: leaderboard
  function renderRace(res) {
    const keys = Object.keys(PLANS).sort((a, b) => res[a].exp_total - res[b].exp_total);
    const max = Math.max(...keys.map(k => res[k].exp_total));
    const a = res.A, d = res.D;
    $("raceLead").textContent = a.exp_total > d.exp_total
      ? `The cheapest plan saves ${money(d.planned_cost - a.planned_cost)} a day on wages, but once missed patients are ` +
        `counted it really costs ${money(a.exp_total - d.exp_total)} more.`
      : "With these settings the cheapest plan is also the cheapest overall.";

    $("race").innerHTML =
      `<div class="race-legend"><span><i style="background:#0F5257"></i>Wages and beds</span>` +
      `<span><i style="background:#B5543C"></i>Overtime + cost of missed patients</span><span>Ranked by real cost, lowest first</span></div>` +
      keys.map((k, i) => {
        const r = res[k], p = PLANS[k];
        const staff = totalOf(p, 0) + totalOf(p, 1) + totalOf(p, 2);
        return `<div class="lane tile${k === "D" ? " pick" : ""}" style="--c:${PLAN_INFO[k][2]};--i:${i}">` +
          `<span class="rank">${i + 1}</span>` +
          `<div class="lane-name"><strong>${PLAN_INFO[k][0]} plan</strong><small>${PLAN_INFO[k][1]} · ${staff} staff · ${p.beds} beds</small></div>` +
          `<div class="lane-track"><div class="bar">${fill("rw-" + k, r.planned_cost / max * 100, "wages")}` +
          `${fill("rr-" + k, (r.exp_total - r.planned_cost) / max * 100, "risk")}</div></div>` +
          `<div class="lane-cost">${count("rc-" + k, r.exp_total, "money")}<small>real cost a day</small></div>` +
          `<div class="lane-ring">${ring("rg-" + k, r.coverage)}<span>${Math.round(r.coverage * 100)}%</span><small>get care</small></div>` +
          `<div class="lane-away"><b>${r.exp_div.toFixed(1)}</b><small>sent away a day</small></div>` +
          (k === "D" ? `<span class="ribbon">Our pick</span>` : "") + `</div>`;
      }).join("");
  }

  // ---------------------------------------------------------------- staff board
  function renderBoard(focus) {
    const plan = PLANS.D, a = state.absent;
    let html = `<div class="board-row board-head"><span></span>${SHIFTS.map(s => `<span>${s}</span>`).join("")}</div>`;
    STAFF.forEach((st, r) => {
      html += `<div class="board-row"><span class="board-role" style="--c:${ROLE_COL[r]}">${PLURAL[st]}</span>`;
      SHIFTS.forEach((sh, j) => {
        const active = a && a.r === r && a.j === j;
        html += `<div class="board-cell${active ? " active" : ""}" role="group" aria-label="${sh} ${PLURAL[st].toLowerCase()}">`;
        for (let i = 0; i < onShift(plan, j, r); i++) {
          const off = active && a.marks.includes(i);
          html += `<button type="button" class="token${off ? " absent" : ""}" style="--c:${ROLE_COL[r]}" data-r="${r}" data-j="${j}" ` +
            `data-i="${i}" aria-pressed="${off}" aria-label="${sh} ${WORD[st]} ${i + 1}${off ? ", absent" : ""}"></button>`;
        }
        html += `</div>`;
      });
      html += `</div>`;
    });
    const msg = state.boardMsg || (a ? `${people(a.marks.length, STAFF[a.r])} marked absent on the ${SHIFTS[a.j].toLowerCase()} shift.`
      : "Everyone is at work.");
    html += `<div class="board-foot"><span>${msg}</span><button type="button" class="link-btn" id="clearBoard"${a ? "" : " disabled"}>Clear board</button></div>`;
    $("board").innerHTML = html;
    if (focus) {
      const again = $("board").querySelector(`.token[data-r="${focus.r}"][data-j="${focus.j}"][data-i="${focus.i}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  $("board").addEventListener("click", e => {
    if (e.target.closest("#clearBoard")) {
      state.absent = null;
      state.boardMsg = "";
      renderBoard();
      scheduleRender();
      return;
    }
    const t = e.target.closest(".token");
    if (!t) return;
    const r = +t.dataset.r, j = +t.dataset.j, i = +t.dataset.i;
    let a = state.absent;
    state.boardMsg = "";
    if (!a || a.r !== r || a.j !== j) {
      if (a) state.boardMsg = "Started a new selection: one shift and role at a time.";
      a = state.absent = { r, j, marks: [] };
    }
    const at = a.marks.indexOf(i);
    if (at >= 0) {
      a.marks.splice(at, 1);
    } else if (a.marks.length >= 3) {
      t.classList.remove("nope");
      void t.offsetWidth;
      t.classList.add("nope");
      state.boardMsg = "You can mark up to 3 people at a time.";
    } else {
      a.marks.push(i);
    }
    if (!a.marks.length) state.absent = null;
    renderBoard({ r, j, i });
    scheduleRender();
  });

  function renderAbsent(s, res) {
    const a = state.absent, normal = res.D;
    if (!a) {
      $("absentResult").innerHTML = `<div class="empty glass"><span class="empty-icon" aria-hidden="true"></span>` +
        `<p><b>Everyone is at work.</b></p><p class="muted">Tap a person on the board to mark them absent. ` +
        `A normal day really costs ${money(normal.exp_total)}.</p></div>`;
      return;
    }
    const staff = STAFF[a.r], shift = SHIFTS[a.j], n = a.marks.length;
    const doNothing = MC.simulate(PLANS.D, P, U, { ...s.opts, unavailable: { [staff + "|" + shift]: n } });
    const fix = s.entry.fix[`${staff}|${shift}|${n}`];
    const fixed = MC.simulate(fix, P, U, s.opts);

    const actions = [];
    SHIFTS.forEach((sh, j) => STAFF.forEach((st, r) => {
      const moreOt = fix.O[MC.idx(j, r)] - PLANS.D.O[MC.idx(j, r)];
      const moreRegular = fix.R[MC.idx(j, r)] - PLANS.D.R[MC.idx(j, r)];
      if (moreOt > 0) actions.push(`Call ${people(moreOt, st)} in on overtime for the ${sh.toLowerCase()} shift.`);
      if (moreRegular > 0 && !(sh === shift && st === staff)) actions.push(`Add ${people(moreRegular, st)} to the ${sh.toLowerCase()} shift.`);
    }));
    const extraWages = MC.plannedCost(fix, P) - MC.plannedCost(PLANS.D, P);

    const card = (key, cls, label, r, note) =>
      `<div class="tile flow-card ${cls}"><div class="label">${label}</div><div class="value">${count(key, r.exp_total, "money")}</div>` +
      `<div class="hint">${pct(r.coverage)} get care</div>${note ? `<div class="flow-note">${note}</div>` : ""}</div>`;

    let todo = "";
    if (fix.partial) todo += `<div class="note warn">There is not enough overtime allowed to fully cover the gap. Raise "Most overtime allowed" or bring in someone from another shift.</div>`;
    if (actions.length) todo += `<ul class="actions">${actions.map(x => `<li>${x}</li>`).join("")}</ul><p class="muted">This adds ${money(extraWages)} in wages for the day.</p>`;
    else if (!fix.partial) todo += `<p>No change needed: the rest of the team can cover.</p>`;

    $("absentResult").innerHTML =
      `<div class="flow-cards">` +
      card("a-normal", "", "Normal day", normal) + `<span class="flow-arrow" aria-hidden="true"></span>` +
      card("a-short", "bad", "Do nothing", doNothing, `${signed(doNothing.exp_total - normal.exp_total)} a day`) +
      `<span class="flow-arrow" aria-hidden="true"></span>` +
      card("a-fixed", "good", "With the fix", fixed, `${signed(fixed.exp_total - doNothing.exp_total)} vs doing nothing`) +
      `</div><div class="todo glass"><h3>What to do: ${people(n, staff)} missing on the ${shift.toLowerCase()} shift</h3>${todo}</div>`;
  }

  // ---------------------------------------------------------------- live shift meter
  const M = { cx: 160, cy: 166, r: 128 };
  const mPoint = (f, r) => {
    const a = Math.PI * (1 - f);
    return [M.cx + r * Math.cos(a), M.cy - r * Math.sin(a)];
  };
  const mArc = (f0, f1) => {
    const [x0, y0] = mPoint(f0, M.r), [x1, y1] = mPoint(f1, M.r);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${M.r} ${M.r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };

  function buildMeter() {
    const svg = $("meter");
    svgEl("path", { d: mArc(0, 1), class: "meter-track" }, svg);
    ["ok", "tight", "over"].forEach(z => svgEl("path", { class: `meter-zone zone-${z}`, "data-zone": z }, svg));
    ["busy", "cap"].forEach(t => svgEl("line", { class: "meter-tick", "data-tick": t }, svg));
    const needle = svgEl("g", { class: "needle" }, svg);
    svgEl("line", { x1: M.cx, y1: M.cy, x2: M.cx, y2: M.cy - M.r + 14, class: "needle-line" }, needle);
    svgEl("circle", { cx: M.cx, cy: M.cy, r: 9, class: "needle-hub" }, svg);
  }

  function renderBusy(s) {
    const shift = segValue("busyShift"), j = SHIFTS.indexOf(shift);
    const soFar = clamp(+$("soFar").value || 0, 0, 500);
    const hours = clamp(+$("hours").value || 0.5, 0.5, 8);
    const usual = P.MU[shift] * s.opts.muMult, busy = usual + P.SD[shift] * s.opts.muMult;
    const expected = soFar * 8 / hours;
    const cap = mainLimit(PLANS.D, j).value;

    let colour, title, advice, pulse = false;
    if ($("emergencyNow").checked) {
      [colour, title, advice, pulse] = ["#8E3520", "Emergency", "Call in all allowed overtime now and book overtime for the next shift. Use the observation area. Only send patients away when every bed is full.", true];
    } else if (expected > cap) {
      [colour, title, advice, pulse] = ["#B5543C", "Surge", "More patients than this shift can handle. Call all allowed overtime and use the observation area for patients waiting for a bed.", true];
    } else if (expected > busy) {
      [colour, title, advice] = ["#A67C3A", "Watch", "Busier than usual. Call overtime for the staff who are short, doctors first."];
    } else {
      [colour, title, advice] = ["#0F5257", "Normal", "Carry on with the planned staff."];
    }

    // Fixed scale around what the shift can handle, so the zones stay readable; a very busy shift pins the needle.
    const scale = Math.max(cap, busy) * 1.4, f = x => clamp(x / scale, 0, 1);
    const z1 = Math.min(f(busy), f(cap)), z2 = f(cap);
    const svg = $("meter");
    svg.querySelector('[data-zone="ok"]').setAttribute("d", mArc(0, z1));
    svg.querySelector('[data-zone="tight"]').setAttribute("d", mArc(z1, z2));
    svg.querySelector('[data-zone="over"]').setAttribute("d", mArc(z2, 1));
    [["busy", busy], ["cap", cap]].forEach(([t, x]) => {
      const [x0, y0] = mPoint(f(x), M.r - 17), [x1, y1] = mPoint(f(x), M.r + 17);
      Object.entries({ x1: x0, y1: y0, x2: x1, y2: y1 }).forEach(([k, v]) => svg.querySelector(`[data-tick="${t}"]`).setAttribute(k, v));
    });
    const needle = svg.querySelector(".needle"), angle = -90 + 180 * f(expected);
    void needle.getBoundingClientRect();
    needle.style.transform = `rotate(${angle}deg)`;

    const key = [["Normal shift", usual, "#5B7C8D"], ["Busy shift", busy, "#C9A66B"], ["Most we can handle", cap, "#B5543C"]];
    $("meterText").innerHTML =
      `<div class="meter-read"><span class="mr-big">${count("m-exp", expected, "int")}</span>` +
      `<span class="mr-sub">patients expected this ${shift.toLowerCase()} shift at this pace (${soFar} × 8 ÷ ${hours} h)</span></div>` +
      `<div class="gauge-key">` + key.map(([label, x, c]) => `<span><i style="--m:${c}"></i>${label} <b>${Math.round(x)}</b></span>`).join("") + `</div>`;
    $("busyResult").innerHTML = `<div class="signal${pulse ? " pulse" : ""}" style="--c:${colour}"><span class="signal-dot"></span>` +
      `<div><b>${title}</b><p>${advice}</p></div></div>`;
  }

  // ---------------------------------------------------------------- situation summary in the top bar
  function updatePill(s) {
    const parts = [];
    if (s.extra) parts.push(`${s.extra > 0 ? "+" : ""}${s.extra}% patients`);
    if (segValue("sick") !== DEFAULTS.sick) parts.push(`sick leave ${document.querySelector('#sick [aria-checked="true"]').textContent.toLowerCase()}`);
    if (segValue("emerg") !== DEFAULTS.emerg) parts.push(`emergencies ${Math.round(+segValue("emerg") * 100)}% of days`);
    if (s.ot !== DEFAULTS.ot) parts.push(`overtime ${s.ot}%`);
    const pill = $("situationPill");
    pill.textContent = parts.length ? parts.join(" · ") : "Normal day";
    pill.classList.toggle("changed", parts.length > 0);
  }

  // ---------------------------------------------------------------- self-check against the Excel model
  function selfCheck() {
    const base = window.MC_BASELINE;
    const ok = Object.keys(PLANS).filter(k => {
      const r = MC.simulate(PLANS[k], P, U, { share: SHARE });
      return Math.abs(r.exp_total - base[k].exp_total) / base[k].exp_total < 0.005 && Math.abs(r.coverage - base[k].coverage) < 0.002;
    }).length;
    const passed = ok === 4;
    $("selfCheck").textContent = passed
      ? "Self-check passed: on a normal day all 4 plans match the group's Excel model."
      : `Self-check: only ${ok} of 4 plans match the Excel model. Please tell the team.`;
    $("checkChip").textContent = passed ? "Matches Excel model" : "Check the numbers";
    $("checkChip").classList.add(passed ? "ok" : "warn");
  }

  // ---------------------------------------------------------------- wiring
  function paintSlider(el) {
    el.style.setProperty("--fill", ((el.value - el.min) / (el.max - el.min)) * 100 + "%");
  }

  function renderAll() {
    const s = settings();
    $("extraOut").textContent = (s.extra > 0 ? "+" : "") + s.extra + "%";
    $("otOut").textContent = s.ot + "%";
    paintSlider($("extra"));
    paintSlider($("ot"));
    updatePill(s);
    const res = {};
    for (const k of Object.keys(PLANS)) res[k] = MC.simulate(PLANS[k], P, U, s.opts);
    $("planLine").textContent = `${totalOf(PLANS.D, 0)} doctors · ${totalOf(PLANS.D, 1)} nurses · ` +
      `${totalOf(PLANS.D, 2)} technicians · ${PLANS.D.beds} beds`;
    updateDial(s, res.D);
    renderVerdict(res.D);
    renderWords(res);
    renderRace(res);
    renderAbsent(s, res);
    renderBusy(s);
    animate();
  }

  // While a slider is dragged, redraw at most once per screen refresh so it glides smoothly.
  let pending = false;
  function scheduleRender() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; renderAll(); });
  }

  function moveSegInk(group) {
    const ink = group.querySelector(".seg-ink"), on = group.querySelector('[aria-checked="true"]');
    ink.style.width = on.offsetWidth + "px";
    ink.style.height = on.offsetHeight + "px";
    ink.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
  }

  function choose(group, button, silent) {
    group.querySelectorAll("button").forEach(b => {
      const on = b === button;
      b.setAttribute("aria-checked", on);
      b.tabIndex = on ? 0 : -1;
    });
    moveSegInk(group);
    if (silent) return;
    if (group.id === "busyShift") $("soFar").value = Math.round(P.MU[button.dataset.value] * settings().opts.muMult / 2);
    scheduleRender();
  }

  document.querySelectorAll(".seg").forEach(group => {
    choose(group, group.querySelector('[aria-checked="true"]'), true);
    group.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (b) choose(group, b);
    });
    group.addEventListener("keydown", e => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const buttons = [...group.querySelectorAll("button")];
      const i = buttons.findIndex(b => b.getAttribute("aria-checked") === "true");
      const next = buttons[(i + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length];
      choose(group, next);
      next.focus();
      e.preventDefault();
    });
  });

  document.addEventListener("click", e => {
    const b = e.target.closest(".step-btn");
    if (!b) return;
    const input = $(b.dataset.target);
    input.value = clamp((+input.value || 0) + +b.dataset.step, +input.min, +input.max);
    scheduleRender();
  });

  ["extra", "ot", "soFar", "hours", "emergencyNow"].forEach(id => $(id).addEventListener("input", scheduleRender));

  $("reset").addEventListener("click", () => {
    $("extra").value = DEFAULTS.extra;
    $("ot").value = DEFAULTS.ot;
    choose($("sick"), $("sick").querySelector(`[data-value="${DEFAULTS.sick}"]`), true);
    choose($("emerg"), $("emerg").querySelector(`[data-value="${DEFAULTS.emerg}"]`), true);
    renderAll();
  });

  window.addEventListener("resize", () => document.querySelectorAll(".seg").forEach(moveSegInk));

  // Sections fade in as they scroll into view; the top-bar link follows the section on screen.
  const sections = [...document.querySelectorAll(".section")];
  const links = [...document.querySelectorAll(".nav-links a")];
  const reveal = new IntersectionObserver(entries => entries.forEach(en => {
    if (en.isIntersecting) { en.target.classList.add("in"); reveal.unobserve(en.target); }
  }), { threshold: 0.08 });
  sections.forEach(sec => reveal.observe(sec));
  function markActive(id) {
    links.forEach(l => l.classList.toggle("active", l.getAttribute("href") === "#" + id));
  }
  const spy = new IntersectionObserver(entries => entries.forEach(en => {
    if (en.isIntersecting) markActive(en.target.id);
  }), { rootMargin: "-45% 0px -50% 0px" });
  sections.forEach(sec => spy.observe(sec));
  window.addEventListener("scroll", () => {
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) markActive(sections[sections.length - 1].id);
  }, { passive: true });

  buildDial();
  buildMeter();
  renderBoard();
  renderAll();
  selfCheck();
})();
