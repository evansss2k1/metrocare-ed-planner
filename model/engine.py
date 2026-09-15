"""Metro Care ED capacity model - optimisation + Monte Carlo engine.
All inputs come from the case exhibits; modelling assumptions are flagged ASSUMPTION.

Refactored so every input lives in a Params dataclass that is passed into solve_plan and
simulate. With Params() defaults the logic and results are identical to the original
engine (engine_original.py); tests/test_acceptance.py proves it."""
import copy, math
from dataclasses import dataclass, field, replace

import numpy as np
import pandas as pd
import pulp
from scipy.stats import norm, binom

SHIFTS = ["Morning", "Evening", "Night"]
RES = ["Doctor", "Nurse", "Technician"]


@dataclass
class Params:
    MU: dict = field(default_factory=lambda: {"Morning": 85, "Evening": 120, "Night": 65})   # Exhibit 1
    SD: dict = field(default_factory=lambda: {"Morning": 12, "Evening": 18, "Night": 10})
    HA: dict = field(default_factory=lambda: {"Morning": 0.22, "Evening": 0.28, "Night": 0.30})
    BH: dict = field(default_factory=lambda: {"Morning": 2.1, "Evening": 2.5, "Night": 2.7})
    PROD: dict = field(default_factory=lambda: {"Doctor": 18, "Nurse": 12, "Technician": 30})  # Exhibit 2
    REG: dict = field(default_factory=lambda: {"Doctor": 9000, "Nurse": 4500, "Technician": 3500})
    OT: dict = field(default_factory=lambda: {"Doctor": 13500, "Nurse": 6500, "Technician": 5000})
    AVAIL: dict = field(default_factory=lambda: {"Doctor": 16, "Nurse": 28, "Technician": 10})
    ABS: dict = field(default_factory=lambda: {"Doctor": 0.04, "Nurse": 0.06, "Technician": 0.05})  # Exhibit 6
    BED_BASE: int = 34
    BED_MAX: int = 44
    BED_COST: float = 1500
    IMG_BASE: int = 52                                        # Exhibit 3
    IMG_ADD: int = 10
    IMG_COST: float = 18000
    LAB_BASE: int = 95
    LAB_ADD: int = 20
    LAB_COST: float = 12000
    PEN_UNCOV: float = 6000                                   # Exhibit 4
    PEN_DIV: float = 9500
    PEN_BEDHR: float = 1200
    CASEMIX: list = field(default_factory=lambda: [(0.70, 1.00), (0.20, 0.90), (0.10, 0.80)])  # Exhibit 5
    INC_P: float = 0.04
    INC_UP: float = 0.35
    BH_VAR: float = 0.20
    OT_CAP: float = 0.25
    HA_MULT: float = 1.5
    SHIFT_HRS: int = 8        # ASSUMPTION: three equal 8-hour shifts
    TARGET: float = 0.95
    NIGHT_DOC_MIN: int = 4
    MIN_TECH: int = 2
    MU_MULT: float = 1.0      # arrival growth multiplier (1.0 = case values)
    ABS_MULT: float = 1.0     # absenteeism multiplier
    DIV_TODAY: float = 5.2    # current diversions/day used for calibration

    def w(self, s):  # doctor workload weight per patient
        return 1 + (self.HA_MULT - 1) * self.HA[s]

    def copy(self, **changes):
        return replace(copy.deepcopy(self), **changes)


DEFAULT = Params()

# Module-level aliases kept for backwards compatibility with the original engine.
MU, SD, HA, BH = DEFAULT.MU, DEFAULT.SD, DEFAULT.HA, DEFAULT.BH
PROD, REG, OT, AVAIL, ABS = DEFAULT.PROD, DEFAULT.REG, DEFAULT.OT, DEFAULT.AVAIL, DEFAULT.ABS
BED_BASE, BED_MAX, BED_COST = DEFAULT.BED_BASE, DEFAULT.BED_MAX, DEFAULT.BED_COST
IMG_BASE, IMG_ADD, IMG_COST = DEFAULT.IMG_BASE, DEFAULT.IMG_ADD, DEFAULT.IMG_COST
LAB_BASE, LAB_ADD, LAB_COST = DEFAULT.LAB_BASE, DEFAULT.LAB_ADD, DEFAULT.LAB_COST
PEN_UNCOV, PEN_DIV, PEN_BEDHR = DEFAULT.PEN_UNCOV, DEFAULT.PEN_DIV, DEFAULT.PEN_BEDHR
CASEMIX, INC_P, INC_UP = DEFAULT.CASEMIX, DEFAULT.INC_P, DEFAULT.INC_UP
BH_VAR, OT_CAP, HA_MULT = DEFAULT.BH_VAR, DEFAULT.OT_CAP, DEFAULT.HA_MULT
SHIFT_HRS, TARGET = DEFAULT.SHIFT_HRS, DEFAULT.TARGET


def w(s, P=DEFAULT):
    return P.w(s)


_SOLVER = None


def get_solver():
    """CBC (PuLP's bundled solver) when it runs on this machine, otherwise HiGHS.
    PuLP ships an Intel-only CBC binary on macOS, which cannot run on Apple Silicon without Rosetta."""
    global _SOLVER
    if _SOLVER is None:
        try:
            t = pulp.LpProblem("probe", pulp.LpMinimize)
            x = pulp.LpVariable("x", 0, 1, "Integer")
            t += x
            t += x >= 0
            t.solve(pulp.PULP_CBC_CMD(msg=0))
            _SOLVER = lambda: pulp.PULP_CBC_CMD(msg=0)
        except Exception:
            _SOLVER = lambda: pulp.HiGHS(msg=0)
    return _SOLVER()


def solve_plan(target=None, abs_allow=False, cf_allow=1.0, max_ot_shifts=1,
               hires_allowed=False, bed_min=None, bed_fixed=None, img=0, lab=0,
               demand_z=0.0, bed_target=None, relax=False, P=None, staff_ub=None, staff_lb=None,
               reg_ub=None):
    """Min-cost ILP. Planned capacity per resource per shift >= target * (mean + z*sd).
    abs_allow: divide by (1-absence prob). cf_allow: case-mix capacity factor planned for.
    staff_ub / staff_lb: optional {(shift, resource): n} bounds on R+O; reg_ub: bound on R only
    (used for what-if repairs)."""
    P = P or DEFAULT
    target = P.TARGET if target is None else target
    bed_min = P.BED_BASE if bed_min is None else bed_min
    mu = {s: P.MU[s] * P.MU_MULT for s in SHIFTS}
    sd = {s: P.SD[s] * P.MU_MULT for s in SHIFTS}
    cat = "Continuous" if relax else "Integer"
    m = pulp.LpProblem("MetroCare", pulp.LpMinimize)
    R = {(s, r): pulp.LpVariable(f"R_{s}_{r}", 0, None, cat) for s in SHIFTS for r in RES}
    O = {(s, r): pulp.LpVariable(f"O_{s}_{r}", 0, None, cat) for s in SHIFTS for r in RES}
    H = {r: pulp.LpVariable(f"H_{r}", 0, None if hires_allowed else 0, cat) for r in RES}
    beds = pulp.LpVariable("beds", bed_min, P.BED_MAX, cat)
    if bed_fixed is not None:
        m += beds == bed_fixed
    y = {s: pulp.LpVariable(f"y_{s}", 0, 1, "Binary") for s in SHIFTS} if not relax else None
    obj = pulp.lpSum(P.REG[r] * R[s, r] + P.OT[r] * O[s, r] for s in SHIFTS for r in RES) \
        + P.BED_COST * (beds - P.BED_BASE) + P.IMG_COST * img + P.LAB_COST * lab
    m += obj
    cons = {}
    for s in SHIFTS:
        dem = target * (mu[s] + demand_z * sd[s])
        for r in RES:
            eff = P.PROD[r] * cf_allow * ((1 - P.ABS[r]) if abs_allow else 1)
            need = dem * (P.w(s) if r == "Doctor" else 1)
            cons[f"Cover_{s}_{r}"] = eff * (R[s, r] + O[s, r]) >= need
            cons[f"OTcap_{s}_{r}"] = O[s, r] <= P.OT_CAP * R[s, r]
            if not relax and max_ot_shifts is not None:
                m += O[s, r] <= 10 * y[s]
            if staff_ub and (s, r) in staff_ub:
                m += R[s, r] + O[s, r] <= staff_ub[s, r]
            if staff_lb and (s, r) in staff_lb:
                m += R[s, r] + O[s, r] >= staff_lb[s, r]
            if reg_ub and (s, r) in reg_ub:
                m += R[s, r] <= reg_ub[s, r]
        bt = bed_target if bed_target is not None else target
        cons[f"Beds_{s}"] = beds * P.SHIFT_HRS / P.BH[s] >= bt * (mu[s] + demand_z * sd[s])
        cons[f"Ratio_{s}"] = 2 * (R[s, "Doctor"] + O[s, "Doctor"]) >= R[s, "Nurse"] + O[s, "Nurse"]
        cons[f"MinTech_{s}"] = R[s, "Technician"] + O[s, "Technician"] >= P.MIN_TECH
    cons["NightDoc"] = R["Night", "Doctor"] + O["Night", "Doctor"] >= P.NIGHT_DOC_MIN
    for r in RES:
        cons[f"Avail_{r}"] = pulp.lpSum(R[s, r] for s in SHIFTS) <= P.AVAIL[r] + H[r]
    if not relax and max_ot_shifts is not None:
        m += pulp.lpSum(y.values()) <= max_ot_shifts
    for k, c in cons.items():
        m += c, k
    st = m.solve(get_solver())
    if pulp.LpStatus[st] != "Optimal":
        return {"status": pulp.LpStatus[st]}
    plan = {"status": "Optimal", "beds": round(beds.value()) if not relax else beds.value(),
            "img": img, "lab": lab, "R": {k: v.value() for k, v in R.items()},
            "O": {k: v.value() for k, v in O.items()}, "H": {r: H[r].value() for r in RES},
            "cost": pulp.value(obj)}
    if relax:
        plan["duals"] = {k: m.constraints[k].pi for k in cons}
        plan["slack"] = {k: m.constraints[k].slack for k in cons}
    else:
        plan["R"] = {k: int(round(v)) for k, v in plan["R"].items()}
        plan["O"] = {k: int(round(v)) for k, v in plan["O"].items()}
        plan["slack"] = {k: m.constraints[k].slack for k in cons}
    # surplus = LHS - RHS in natural units (>= 0 when satisfied, ~0 when binding)
    plan["surplus"] = {k: (c.value() if c.sense >= 0 else -c.value()) for k, c in cons.items()}
    plan["settings"] = dict(target=target, abs_allow=abs_allow, cf_allow=cf_allow,
                            max_ot_shifts=max_ot_shifts, hires_allowed=hires_allowed,
                            bed_min=bed_min, bed_fixed=bed_fixed, img=img, lab=lab)
    return plan


def planned_cost(p, P=None):
    P = P or DEFAULT
    staff = sum(P.REG[r] * p["R"][s, r] + P.OT[r] * p["O"][s, r] for s in SHIFTS for r in RES)
    return staff + P.BED_COST * (p["beds"] - P.BED_BASE) + P.IMG_COST * p["img"] + P.LAB_COST * p["lab"]


def random_numbers(n, seed=2026):
    g = np.random.default_rng(seed)
    f = lambda *sh: np.clip(np.round(g.random(sh), 6), 0.000001, 0.999999)
    return {"cm": f(n), "inc": f(n), "incs": f(n),
            "arr": f(n, 3), "bh": f(n, 3),
            "abs": {r: f(n, 3) for r in RES}}


def load_random_numbers(path="random_numbers.csv"):
    """Load the 2,000 simulated days used by the Excel model (same days for every strategy)."""
    df = pd.read_csv(path)
    sh = ["morning", "evening", "night"]
    tag = {"Doctor": "doctor", "Nurse": "nurse", "Technician": "tech"}
    return {"cm": df["u_casemix"].to_numpy(), "inc": df["u_incident"].to_numpy(),
            "incs": df["u_incident_shift"].to_numpy(),
            "arr": df[[f"u_arr_{s}" for s in sh]].to_numpy(),
            "bh": df[[f"u_bedhrs_{s}" for s in sh]].to_numpy(),
            "abs": {r: df[[f"u_abs_{tag[r]}_{s}" for s in sh]].to_numpy() for r in RES}}


def simulate(p, U, div_share, pen_uncov=None, pen_div=None, pen_bedhr=None,
             mu_mult=None, inc_up=None, inc_p=None, abs_mult=None, ot_cap=None,
             img_rate=None, lab_rate=None, unavailable=None, target=None, P=None):
    """Monte Carlo over all days. Any keyword left as None is taken from P (Params)."""
    P = P or DEFAULT
    pen_uncov = P.PEN_UNCOV if pen_uncov is None else pen_uncov
    pen_div = P.PEN_DIV if pen_div is None else pen_div
    pen_bedhr = P.PEN_BEDHR if pen_bedhr is None else pen_bedhr
    mu_mult = P.MU_MULT if mu_mult is None else mu_mult
    inc_up = P.INC_UP if inc_up is None else inc_up
    inc_p = P.INC_P if inc_p is None else inc_p
    abs_mult = P.ABS_MULT if abs_mult is None else abs_mult
    ot_cap = P.OT_CAP if ot_cap is None else ot_cap
    target = P.TARGET if target is None else target
    n = len(U["cm"])
    cmu = U["cm"]
    cf = np.where(cmu < 0.70, 1.0, np.where(cmu < 0.90, 0.9, 0.8))
    inc = U["inc"] < inc_p
    inc_shift = np.floor(U["incs"] * 3).astype(int)
    out = {k: np.zeros((n, 3)) for k in ["A", "div", "board", "uncov", "surge_cost", "surge_staff",
                                          "served", "bedutil", "diag_block"]}
    for j, s in enumerate(SHIFTS):
        mean = P.MU[s] * mu_mult * np.where(inc & (inc_shift == j), 1 + inc_up, 1.0)
        sdv = P.SD[s] * mu_mult * np.where(inc & (inc_shift == j), 1 + inc_up, 1.0)
        A = np.maximum(0, np.floor(norm.ppf(U["arr"][:, j], mean, sdv) + 0.5))
        bh = P.BH[s] * (1 - P.BH_VAR + 2 * P.BH_VAR * U["bh"][:, j])
        B = p["beds"] * P.SHIFT_HRS / bh
        over = np.maximum(0, A - B)
        div = div_share * over
        board = (1 - div_share) * over * bh
        Rt = A - div
        surge_cost = np.zeros(n); surge_staff = np.zeros(n)
        caps_after = []
        for r in RES:
            rostered = p["R"][s, r] + p["O"][s, r]
            if unavailable and r in unavailable:
                rostered = max(0, rostered - unavailable[r].get(s, 0))
            pa = min(1, P.ABS[r] * abs_mult)
            present = binom.ppf(U["abs"][r][:, j], rostered, 1 - pa) if rostered > 0 else np.zeros(n)
            wgt = P.w(s) if r == "Doctor" else 1.0
            per = P.PROD[r] * cf / wgt
            need = np.ceil(Rt / per - 1e-9)
            ot_room = max(0, math.floor(ot_cap * p["R"][s, r] + 1e-9) - p["O"][s, r])
            add = np.clip(need - present, 0, ot_room)
            surge_cost += add * P.OT[r]; surge_staff += add
            caps_after.append((present + add) * per)
        cap = np.minimum.reduce(caps_after)
        out.setdefault("bind", np.zeros((n, 3), dtype=int))[:, j] = np.argmin(np.vstack(caps_after), axis=0)
        if img_rate or lab_rate:
            cap_d = np.full(n, np.inf)
            if img_rate:
                cap_d = np.minimum(cap_d, (P.IMG_BASE + P.IMG_ADD * p["img"]) / (img_rate / cf))
            if lab_rate:
                cap_d = np.minimum(cap_d, (P.LAB_BASE + P.LAB_ADD * p["lab"]) / (lab_rate / cf))
            out["diag_block"][:, j] = np.maximum(0, np.minimum(Rt, cap) - cap_d)
            cap = np.minimum(cap, cap_d)
        uncov = np.maximum(0, Rt - cap)
        out["A"][:, j] = A; out["div"][:, j] = div; out["board"][:, j] = board
        out["uncov"][:, j] = uncov; out["surge_cost"][:, j] = surge_cost
        out["surge_staff"][:, j] = surge_staff; out["served"][:, j] = A - div - uncov
        out["bedutil"][:, j] = np.minimum(A * bh, p["beds"] * P.SHIFT_HRS) / (p["beds"] * P.SHIFT_HRS)
    base = planned_cost(p, P)
    pen = pen_uncov * out["uncov"].sum(1) + pen_div * out["div"].sum(1) + pen_bedhr * out["board"].sum(1)
    total = base + out["surge_cost"].sum(1) + pen
    cov = out["served"] / np.maximum(out["A"], 1)
    fail_shift = cov < target
    res = {
        "planned_cost": base,
        "exp_surge_ot": out["surge_cost"].sum(1).mean(),
        "exp_penalty": pen.mean(),
        "exp_total": total.mean(), "p95_total": np.percentile(total, 95),
        "se_total": total.std(ddof=1) / math.sqrt(n),
        "exp_div": out["div"].sum(1).mean(), "exp_uncov": out["uncov"].sum(1).mean(),
        "exp_board_hrs": out["board"].sum(1).mean(),
        "coverage": out["served"].sum() / out["A"].sum(),
        "p_target_day": (~fail_shift.any(1)).mean(),
        "p_fail_shift": fail_shift.mean(0),
        "p_div_day": (out["div"].sum(1) > 0).mean(),
        "surge_staff_day": out["surge_staff"].sum(1).mean(),
        "bedutil": out["bedutil"].mean(0),
        "div_by_shift": out["div"].mean(0), "uncov_by_shift": out["uncov"].mean(0),
        "board_by_shift": out["board"].mean(0), "surge_by_shift": out["surge_cost"].mean(0),
        "diag_block": out["diag_block"].sum(1).mean(),
        "exp_pen_uncov": pen_uncov * out["uncov"].sum(1).mean(),
        "exp_pen_div": pen_div * out["div"].sum(1).mean(),
        "exp_pen_board": pen_bedhr * out["board"].sum(1).mean(),
        "bind_share": {s: np.bincount(out["bind"][:, j], minlength=3) / n for j, s in enumerate(SHIFTS)},
        "total_series": total, "pen_series": pen, "surge_series": out["surge_cost"].sum(1), "_out": out, "cf": cf,
    }
    # overtime days in >1 shift (planned OT shifts + surge shifts)
    planned_ot_shift = np.array([1 if sum(p["O"][s, r] for r in RES) > 0 else 0 for s in SHIFTS])
    ot_shift = ((out["surge_staff"] > 0) | (planned_ot_shift[None, :] > 0)).sum(1)
    res["p_ot_multi"] = (ot_shift > 1).mean()
    res["p_any_ot"] = (ot_shift > 0).mean()
    return res


def calibrate_div_share(U, P=None):
    """ASSUMPTION: today's 5.2 diversions/day are caused by bed overflow at 34 beds.
    share = 5.2 / expected daily bed-overflow patients at 34 beds. Always calibrated on the
    case inputs (today's performance), not on what-if changes."""
    P = P or DEFAULT
    n = len(U["cm"]); inc = U["inc"] < P.INC_P; incs = np.floor(U["incs"] * 3).astype(int)
    tot = np.zeros(n)
    for j, s in enumerate(SHIFTS):
        f = np.where(inc & (incs == j), 1 + P.INC_UP, 1.0)
        A = np.maximum(0, np.floor(norm.ppf(U["arr"][:, j], P.MU[s] * f, P.SD[s] * f) + 0.5))
        bh = P.BH[s] * (1 - P.BH_VAR + 2 * P.BH_VAR * U["bh"][:, j])
        tot += np.maximum(0, A - P.BED_BASE * P.SHIFT_HRS / bh)
    return P.DIV_TODAY / tot.mean(), tot.mean()


# ---------------------------------------------------------------- strategies
def _plan(reg, ot, beds, img=0, lab=0):
    return {"status": "Optimal", "R": {(s, r): reg[i][k] for i, s in enumerate(SHIFTS) for k, r in enumerate(RES)},
            "O": {(s, r): ot[i][k] for i, s in enumerate(SHIFTS) for k, r in enumerate(RES)},
            "beds": beds, "img": img, "lab": lab}


# Strategy D is a fixed plan from the simulation search (not an LP output).
PLAN_D = _plan([[6, 8, 4], [9, 12, 5], [5, 7, 4]], [[0, 0, 0]] * 3, 44)

STRATEGY_SETTINGS = {
    "A": dict(),
    "B": dict(target=1.0, abs_allow=True, max_ot_shifts=None),
    "C": dict(target=1.0, abs_allow=True, cf_allow=0.9, hires_allowed=True, bed_min=44, img=1, lab=1),
}
STRATEGY_NAMES = {"A": "Cost-Minimum", "B": "Service-Oriented", "C": "Resilient",
                  "D": "Targeted Resilience"}
# Planning rule that Strategy D satisfies in every shift; used to explain D and to re-solve it
# in what-if repairs and target sensitivity. D itself stays the stored simulation-search plan.
D_SETTINGS = dict(target=0.95, abs_allow=True, cf_allow=0.9, hires_allowed=True, bed_fixed=44)


def strategy_plans(P=None):
    """A-C re-solved with the current Params; D is the stored plan."""
    P = P or DEFAULT
    plans = {k: solve_plan(P=P, **kw) for k, kw in STRATEGY_SETTINGS.items()}
    plans["D"] = copy.deepcopy(PLAN_D)
    plans["D"]["settings"] = dict(D_SETTINGS)
    return plans


def revise_plan(plan, unavailable, P=None, settings=None):
    """Re-solve after staff become unavailable (minimum-cost repair).
    Keeps every other shift's headcount, caps regular staff in the affected shift at (current - lost),
    removes the lost staff from the pool, and lets the LP restore the plan's own planning rule with
    overtime (within the cap), new posts if allowed, or other staff. If no repair exists, returns the
    reduced roster with the overtime room used and repair='partial'."""
    P = P or DEFAULT
    st = dict(settings if settings is not None else (plan.get("settings") or D_SETTINGS))
    lost = {(s, r): int(n) for r, d in unavailable.items() for s, n in d.items() if n}
    st.update(max_ot_shifts=None, bed_fixed=plan["beds"], img=plan["img"], lab=plan["lab"])
    st.pop("bed_min", None)
    pool = {r: max(0, P.AVAIL[r] - sum(n for (_, rr), n in lost.items() if rr == r)) for r in RES}
    lb = {k: plan["R"][k] + plan["O"][k] for k in plan["R"] if k not in lost}
    reg_ub = {k: max(0, plan["R"][k] - n) for k, n in lost.items()}
    new = solve_plan(P=P.copy(AVAIL=pool), staff_lb=lb, reg_ub=reg_ub, **st)
    if new.get("status") == "Optimal":
        new["repair"] = "lp"
        return new
    new = {"status": "Optimal", "R": dict(plan["R"]), "O": dict(plan["O"]), "beds": plan["beds"],
           "img": plan["img"], "lab": plan["lab"], "settings": st, "repair": "partial"}
    for (s, r), n in lost.items():
        R0, O0 = plan["R"][s, r], plan["O"][s, r]
        R1 = max(0, R0 - n)
        o_left = max(0, R0 + O0 - n - R1)
        room = math.floor(P.OT_CAP * R1 + 1e-9)
        new["R"][s, r], new["O"][s, r] = R1, min(R0 + O0 - R1, max(o_left, room))
    return new


def plan_from_json(d):
    split = lambda m: {tuple(k.split("|")): v for k, v in m.items()}
    return {"status": "Optimal", "R": split(d["regular"]), "O": split(d["planned_overtime"]),
            "beds": d["beds"], "img": d["imaging_expansion"], "lab": d["lab_expansion"]}
