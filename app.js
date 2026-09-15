// The screens. All maths is in simulate.js (simulation) and data/plans.js (plans solved by model/engine.py).
(function () {
  const P = window.MC_PARAMS, U = window.MC_DAYS, ALL_PLANS = window.MC_PLANS, MC = window.MC;
  const SHIFTS = MC.SHIFTS, STAFF = MC.STAFF;
  const SHARE = MC.calibrate(P, U);
  const $ = id => document.getElementById(id);
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const PLAN_INFO = {
    D: ["Recommended plan", "Enough staff in each shift, plus 44 beds.", "#0F5257"],
    A: ["Cheapest plan", "Pay as little as possible for staff.", "#9AA0A6"],
    B: ["Service-first plan", "Try to see everyone, using lots of overtime.", "#C9A66B"],
    C: ["Maximum safety plan", "Most staff and beds, plus extra scan and lab capacity.", "#5B7C8D"],
  };
  const WORD = { Doctor: "doctor", Nurse: "nurse", Technician: "technician" };
  const PLURAL = { Doctor: "Doctors", Nurse: "Nurses", Technician: "Technicians" };

  // ---------------------------------------------------------------- helpers
  const money = x => "₹" + Math.round(x).toLocaleString("en-US");
  const pct = (x, d = 1) => (x * 100).toFixed(d) + "%";
  const people = (n, staff) => `${n} ${WORD[staff]}${n === 1 ? "" : "s"}`;
  const onShift = (plan, j, r) => plan.R[MC.idx(j, r)] + plan.O[MC.idx(j, r)];
  const totalOf = (plan, r) => onShift(plan, 0, r) + onShift(plan, 1, r) + onShift(plan, 2, r);
  const FMT = { money, pct1: x => pct(x, 1), pct0: x => pct(x, 0), dec1: x => x.toFixed(1), int: x => String(Math.round(x)) };

  // Last shown value of every animated number / bar, so changes animate from where they were.
  const shown = {};

  function tiles(items, extraClass = "") {
    return `<div class="tiles ${extraClass}">` + items.map((t, i) => {
      const from = shown[t.key] ?? (t.fmt === "money" ? t.value * 0.9 : 0);
      return `<div class="tile${t.bad ? " bad" : ""}" style="--i:${i}"><div class="label">${t.label}</div>` +
        `<div class="value"><span class="count" data-key="${t.key}" data-from="${from}" data-to="${t.value}" data-fmt="${t.fmt}">` +
        `${FMT[t.fmt](from)}</span>${t.unit ? `<small>${t.unit}</small>` : ""}</div><div class="hint">${t.hint}</div></div>`;
    }).join("") + "</div>";
  }

  // A bar segment that grows from its last width to the new one
  function seg(key, width, cls, extraStyle = "") {
    return `<span class="seg ${cls}" data-key="${key}" data-w="${width}" style="width:${shown[key] ?? 0}%;${extraStyle}"></span>`;
  }

  function animate() {
    document.querySelectorAll(".count").forEach(el => {
      const from = +el.dataset.from, to = +el.dataset.to, f = FMT[el.dataset.fmt];
      shown[el.dataset.key] = to;
      if (REDUCED || from === to) { el.textContent = f(to); return; }
      const start = performance.now(), duration = 700;
      const step = now => {
        const k = Math.min(1, (now - start) / duration), eased = 1 - Math.pow(1 - k, 3);
        el.textContent = f(from + (to - from) * eased);
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    document.querySelectorAll("[data-w]").forEach(el => {
      shown[el.dataset.key] = +el.dataset.w;
      requestAnimationFrame(() => requestAnimationFrame(() => { el.style.width = el.dataset.w + "%"; }));
    });
    document.querySelectorAll("[data-left]").forEach(el => {
      shown[el.dataset.key] = +el.dataset.left;
      requestAnimationFrame(() => requestAnimationFrame(() => { el.style.left = el.dataset.left + "%"; }));
    });
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
    return [name, limits[name]];
  }

  function settings() {
    const extra = +$("extra").value, ot = +$("ot").value;
    return {
      extra, ot, entry: ALL_PLANS[extra + "|" + ot],
      opts: { share: SHARE, muMult: 1 + extra / 100, absMult: +$("sick").value, incP: +$("emerg").value, otCap: ot / 100 },
    };
  }

  // ---------------------------------------------------------------- Tab: our plan
  function renderPlan(plans, res, s) {
    const plan = plans.D, r = res.D;
    const lost = [0, 1, 2].map(j => r.uncov_by_shift[j] + r.div_by_shift[j]);
    const hardest = lost.indexOf(Math.max(...lost));
    const points = [
      `Wages and beds cost ${money(r.planned_cost)} a day. Overtime and the cost of patients we cannot help add about ` +
      `${money(r.exp_total - r.planned_cost)}, so the real cost is ${money(r.exp_total)}.`,
      `About ${Math.round(r.coverage * 100)} out of every 100 patients get care, and about ${r.exp_div.toFixed(1)} ` +
      `patients a day are sent to another hospital (today it is 5.2).`,
      `The hardest shift is the ${SHIFTS[hardest].toLowerCase()}. What holds it back most is the number of ${mainLimit(plan, hardest)[0]}.`,
    ];
    if (res.A) {
      points.push(res.A.exp_total > r.exp_total
        ? `The cheapest plan saves ${money(r.planned_cost - res.A.planned_cost)} on wages, but it misses so many patients ` +
          `that it really costs ${money(res.A.exp_total - r.exp_total)} more a day.`
        : "With these settings the cheapest plan is also the cheapest overall, so the extra staff may not be worth it.");
    }

    const shiftCards = SHIFTS.map((sh, j) =>
      `<div class="shift glass" style="--i:${j + 4}"><div class="shift-head"><h4>${sh}</h4>` +
      `<span>${Math.round(P.MU[sh] * s.opts.muMult)} patients expected</span></div>` +
      STAFF.map((st, k) => {
        const ot = plan.O[MC.idx(j, k)];
        return `<div class="staff-row"><span class="dot dot-${k}"></span><span>${PLURAL[st]}</span>` +
          (ot ? `<span class="ot">+${ot} overtime</span>` : "") + `<b>${plan.R[MC.idx(j, k)]}</b></div>`;
      }).join("") +
      `<div class="limit">Main limit: <b>${mainLimit(plan, j)[0]}</b></div></div>`).join("");

    $("tab-plan").innerHTML =
      `<div class="reco"><small>Our recommendation</small><p><b>${totalOf(plan, 0)} doctors, ${totalOf(plan, 1)} nurses and ` +
      `${totalOf(plan, 2)} technicians</b> a day, with <b>${plan.beds} beds</b>.</p></div>` +
      tiles([
        { key: "p-cost", label: "Real cost per day", value: r.exp_total, fmt: "money", hint: "wages, beds, overtime and missed patients", bad: false },
        { key: "p-care", label: "Patients who get care", value: r.coverage, fmt: "pct1", hint: "out of everyone who arrives", bad: r.coverage < 0.95 },
        { key: "p-div", label: "Sent to another hospital", value: r.exp_div, fmt: "dec1", unit: "a day", hint: "today it is 5.2 a day", bad: r.exp_div > 2 },
        { key: "p-good", label: "Good days", value: r.p_target_day, fmt: "pct0", hint: "every shift sees at least 95% of patients", bad: r.p_target_day < 0.5 },
      ]) +
      `<div class="shifts">${shiftCards}</div>` +
      `<div class="card glass"><h3>In simple words</h3><ul class="ticks">${points.map(p => `<li>${p}</li>`).join("")}</ul></div>`;
  }

  // ---------------------------------------------------------------- Tab: compare
  function renderCompare(plans, res) {
    const keys = ["D", "A", "B", "C"].filter(k => res[k]);
    const missing = ["A", "B", "C"].filter(k => !res[k]).map(k => PLAN_INFO[k][0]);
    const max = Math.max(...keys.map(k => res[k].exp_total));
    const best = keys.reduce((a, b) => (res[b].exp_total < res[a].exp_total ? b : a));

    $("tab-compare").innerHTML =
      (missing.length ? `<div class="note warn">${missing.join(", ")}: not possible with today's staff under these settings.</div>` : "") +
      `<div class="plan-cards">` + keys.map((k, i) =>
        `<div class="plan-card glass" style="--c:${PLAN_INFO[k][2]};--i:${i}"><h4>${PLAN_INFO[k][0]}` +
        (k === "D" ? ` <span class="badge">Best</span>` : "") + `</h4><p>${PLAN_INFO[k][1]}</p></div>`).join("") + `</div>` +
      `<div class="card glass"><h3>Side by side</h3><p class="muted">All plans are tested on the same 2,000 made-up days, so the comparison is fair.</p>
        <div class="table-wrap"><table><thead>
        <tr><th>Plan</th><th class="num">Staff a day</th><th class="num">Beds</th><th class="num">Real cost a day</th><th class="num">Get care</th><th class="num">Sent away a day</th></tr></thead><tbody>` +
      keys.map(k => `<tr class="${k === "D" ? "best" : ""}"><td>${PLAN_INFO[k][0]}</td>` +
        `<td class="num">${totalOf(plans[k], 0) + totalOf(plans[k], 1) + totalOf(plans[k], 2)}</td>` +
        `<td class="num">${plans[k].beds}</td><td class="num">${money(res[k].exp_total)}</td>` +
        `<td class="num">${pct(res[k].coverage, 0)}</td><td class="num">${res[k].exp_div.toFixed(1)}</td></tr>`).join("") +
      `</tbody></table></div></div>
      <div class="card glass"><h3>Real cost per day</h3>
      <div class="legend"><span><i style="background:#0F5257"></i>Wages and beds</span><span><i style="background:#B5543C"></i>Overtime + cost of missed patients</span><span>Shorter is better</span></div>` +
      keys.map(k => `<div class="bar-row"><span>${PLAN_INFO[k][0]}</span><div class="bar">` +
        seg("bw-" + k, (res[k].planned_cost / max) * 100, "wages") +
        seg("br-" + k, ((res[k].exp_total - res[k].planned_cost) / max) * 100, "risk") +
        `</div><span class="num">${money(res[k].exp_total)}</span></div>`).join("") +
      `</div><div class="note good">Lowest real cost: <b>${PLAN_INFO[best][0]}</b> at ${money(res[best].exp_total)} a day.</div>`;
  }

  // ---------------------------------------------------------------- Tab: someone is absent
  function renderAbsent(plans, res, s) {
    const staff = $("absStaff").value, shift = $("absShift").value, n = +$("absN").value;
    const plan = plans.D, normal = res.D;
    const doNothing = MC.simulate(plan, P, U, { ...s.opts, unavailable: { [staff + "|" + shift]: n } });
    const fix = s.entry.fix[`${staff}|${shift}|${n}`];
    const fixed = MC.simulate(fix, P, U, s.opts);

    const actions = [];
    SHIFTS.forEach((sh, j) => STAFF.forEach((st, r) => {
      const moreOt = fix.O[MC.idx(j, r)] - plan.O[MC.idx(j, r)];
      const moreRegular = fix.R[MC.idx(j, r)] - plan.R[MC.idx(j, r)];
      if (moreOt > 0) actions.push(`Call ${people(moreOt, st)} in on overtime for the ${sh.toLowerCase()} shift.`);
      if (moreRegular > 0 && !(sh === shift && st === staff)) actions.push(`Add ${people(moreRegular, st)} to the ${sh.toLowerCase()} shift.`);
    }));
    const extraWages = MC.plannedCost(fix, P) - MC.plannedCost(plan, P);

    let todo = "";
    if (fix.partial) todo += `<div class="note warn">There is not enough overtime allowed to fully cover the gap. Raise "Most overtime allowed" or bring in someone from another shift.</div>`;
    if (actions.length) todo += `<ul class="actions">${actions.map(a => `<li>${a}</li>`).join("")}</ul><p class="muted">This adds ${money(extraWages)} in wages for the day.</p>`;
    else if (!fix.partial) todo += `<p>No change needed: the rest of the team can cover.</p>`;

    $("absentResult").innerHTML =
      tiles([
        { key: "a-normal", label: "Normal day", value: normal.exp_total, fmt: "money", hint: pct(normal.coverage) + " of patients get care", bad: false },
        { key: "a-short", label: "Short-staffed, do nothing", value: doNothing.exp_total, fmt: "money", hint: pct(doNothing.coverage) + " of patients get care", bad: true },
        { key: "a-fixed", label: "Short-staffed, with the fix", value: fixed.exp_total, fmt: "money", hint: pct(fixed.coverage) + " of patients get care", bad: false },
      ]) +
      `<div class="card glass"><h3>What to do</h3>${todo}<p class="help">With ${people(n, staff)} missing and nothing done, ` +
      `the real cost goes up by ${money(doNothing.exp_total - normal.exp_total)} a day, because more patients wait or are sent away.</p></div>`;
  }

  // ---------------------------------------------------------------- Tab: busy shift check
  function renderBusy(plans, s) {
    const shift = $("busyShift").value, j = SHIFTS.indexOf(shift);
    const soFar = Math.min(500, Math.max(0, +$("soFar").value || 0));
    const hours = Math.min(8, Math.max(0.5, +$("hours").value || 0.5));
    const usual = P.MU[shift] * s.opts.muMult, busy = usual + P.SD[shift] * s.opts.muMult;
    const expected = soFar * 8 / hours;
    const canHandle = mainLimit(plans.D, j)[1];

    let colour, title, advice, pulse = false;
    if ($("emergencyNow").checked) {
      [colour, title, advice, pulse] = ["#8E3520", "Emergency", "Call in all allowed overtime now and book overtime for the next shift. Use the observation area. Only send patients away when every bed is full.", true];
    } else if (expected > canHandle) {
      [colour, title, advice, pulse] = ["#B5543C", "Surge", "More patients than this shift can handle. Call all allowed overtime and use the observation area for patients waiting for a bed.", true];
    } else if (expected > busy) {
      [colour, title, advice] = ["#A67C3A", "Watch", "Busier than usual. Call overtime for the staff who are short, doctors first."];
    } else {
      [colour, title, advice] = ["#0F5257", "Normal", "Carry on with the planned staff."];
    }

    // Fixed scale around what the shift can handle, so the markers stay readable; a very busy shift fills the bar.
    const scale = Math.max(canHandle, busy) * 1.4;
    const at = x => Math.min(100, (x / scale) * 100);
    const MARKS = [["m-usual", usual, "Normal shift", "#5B7C8D"], ["m-busy", busy, "Busy shift", "#C9A66B"],
      ["m-cap", canHandle, "Most we can handle", "#B5543C"]];
    const mark = ([key, x, , colour]) =>
      `<span class="mark" data-key="${key}" data-left="${at(x)}" style="left:${shown[key] ?? at(x)}%;--m:${colour}"></span>`;

    $("busyResult").innerHTML =
      `<div class="signal${pulse ? " pulse" : ""}" style="--c:${colour}"><span class="signal-dot"></span><div><b>${title}</b><p>${advice}</p></div></div>` +
      `<div class="card glass"><h3>This shift at a glance</h3>
        <p>At this pace we expect about <b>${Math.round(expected)} patients</b> this ${shift.toLowerCase()} shift.</p>
        <div class="gauge" style="--c:${colour}">${seg("gauge", at(expected), "", `background:linear-gradient(90deg,#1B7A80,${colour})`)}` +
      MARKS.map(mark).join("") + `</div>
        <div class="gauge-key"><span><i style="--m:${colour}"></i>Expected <b>${Math.round(expected)}</b></span>` +
      MARKS.map(([, x, label, c]) => `<span><i style="--m:${c}"></i>${label} <b>${Math.round(x)}</b></span>`).join("") +
      `</div></div>`;
  }

  // ---------------------------------------------------------------- self-check against the Excel model
  function selfCheck() {
    const base = window.MC_BASELINE, entry = ALL_PLANS["0|25"];
    const plans = { A: entry.A, B: entry.B, C: entry.C, D: P.D };
    const ok = Object.keys(plans).filter(k => {
      const r = MC.simulate(plans[k], P, U, { share: SHARE });
      return Math.abs(r.exp_total - base[k].exp_total) / base[k].exp_total < 0.005 &&
        Math.abs(r.coverage - base[k].coverage) < 0.002;
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
    // The four rosters stay fixed, exactly as in the Excel Sensitivity sheet and the report: the sidebar changes the
    // situation (patients, sick leave, emergencies, overtime room), not the plans. Only the absence fix is re-planned.
    const base = ALL_PLANS["0|25"];
    const plans = { D: P.D, A: base.A, B: base.B, C: base.C };
    const res = {};
    for (const k of Object.keys(plans)) if (plans[k]) res[k] = MC.simulate(plans[k], P, U, s.opts);
    renderPlan(plans, res, s);
    renderCompare(plans, res);
    renderAbsent(plans, res, s);
    renderBusy(plans, s);
    animate();
  }

  const ink = document.querySelector(".tab-ink");
  function moveInk() {
    const active = document.querySelector('.tabs button[aria-selected="true"]');
    ink.style.width = active.offsetWidth + "px";
    ink.style.transform = `translateX(${active.offsetLeft}px)`;
  }

  function openTab(btn) {
    document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", b === btn));
    document.querySelectorAll(".panel").forEach(p => {
      const show = p.id === "tab-" + btn.dataset.tab;
      p.hidden = !show;
      if (show) {
        p.classList.add("just-opened");
        setTimeout(() => p.classList.remove("just-opened"), 900);
      }
    });
    moveInk();
    btn.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "nearest", inline: "nearest" });
    animate();
  }

  document.querySelectorAll(".tabs button").forEach(btn => btn.addEventListener("click", () => openTab(btn)));
  // While a slider is dragged, redraw at most once per screen refresh so the thumb glides smoothly.
  let pending = false;
  function scheduleRender() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; renderAll(); });
  }
  ["extra", "sick", "emerg", "ot", "absStaff", "absShift", "absN", "soFar", "hours", "emergencyNow"]
    .forEach(id => $(id).addEventListener("input", scheduleRender));
  $("busyShift").addEventListener("change", () => {
    $("soFar").value = Math.round(P.MU[$("busyShift").value] * settings().opts.muMult / 2);
    renderAll();
  });
  $("reset").addEventListener("click", () => {
    $("extra").value = 0; $("ot").value = 25; $("sick").value = "1"; $("emerg").value = "0.04";
    renderAll();
  });
  window.addEventListener("resize", moveInk);

  $("tab-plan").classList.add("just-opened");
  setTimeout(() => $("tab-plan").classList.remove("just-opened"), 900);
  renderAll();
  moveInk();
  selfCheck();
})();
