"""Metro Care ED capacity model - optimisation + Monte Carlo engine.
All inputs come from the case exhibits; modelling assumptions are flagged ASSUMPTION."""
import math, numpy as np, pulp

SHIFTS = ["Morning", "Evening", "Night"]
MU = {"Morning": 85, "Evening": 120, "Night": 65}          # Exhibit 1
SD = {"Morning": 12, "Evening": 18, "Night": 10}
HA = {"Morning": 0.22, "Evening": 0.28, "Night": 0.30}
BH = {"Morning": 2.1, "Evening": 2.5, "Night": 2.7}
RES = ["Doctor", "Nurse", "Technician"]
PROD = {"Doctor": 18, "Nurse": 12, "Technician": 30}       # Exhibit 2
REG = {"Doctor": 9000, "Nurse": 4500, "Technician": 3500}
OT = {"Doctor": 13500, "Nurse": 6500, "Technician": 5000}
AVAIL = {"Doctor": 16, "Nurse": 28, "Technician": 10}
ABS = {"Doctor": 0.04, "Nurse": 0.06, "Technician": 0.05}  # Exhibit 6
BED_BASE, BED_MAX, BED_COST = 34, 44, 1500
IMG_BASE, IMG_ADD, IMG_COST = 52, 10, 18000                # Exhibit 3
LAB_BASE, LAB_ADD, LAB_COST = 95, 20, 12000
PEN_UNCOV, PEN_DIV, PEN_BEDHR = 6000, 9500, 1200           # Exhibit 4
CASEMIX = [(0.70, 1.00), (0.20, 0.90), (0.10, 0.80)]       # Exhibit 5
INC_P, INC_UP = 0.04, 0.35
BH_VAR = 0.20
OT_CAP = 0.25
HA_MULT = 1.5
SHIFT_HRS = 8          # ASSUMPTION: three equal 8-hour shifts
TARGET = 0.95

def w(s):  # doctor workload weight per patient
    return 1 + (HA_MULT - 1) * HA[s]

def solve_plan(target=TARGET, abs_allow=False, cf_allow=1.0, max_ot_shifts=1,
               hires_allowed=False, bed_min=BED_BASE, bed_fixed=None, img=0, lab=0,
               demand_z=0.0, bed_target=None, relax=False):
    """Min-cost ILP. Planned capacity per resource per shift >= target * (mean + z*sd).
    abs_allow: divide by (1-absence prob). cf_allow: case-mix capacity factor planned for."""
    cat = "Continuous" if relax else "Integer"
    m = pulp.LpProblem("MetroCare", pulp.LpMinimize)
    R = {(s, r): pulp.LpVariable(f"R_{s}_{r}", 0, None, cat) for s in SHIFTS for r in RES}
    O = {(s, r): pulp.LpVariable(f"O_{s}_{r}", 0, None, cat) for s in SHIFTS for r in RES}
    H = {r: pulp.LpVariable(f"H_{r}", 0, None if hires_allowed else 0, cat) for r in RES}
    beds = pulp.LpVariable("beds", bed_min, BED_MAX, cat)
    if bed_fixed is not None:
        m += beds == bed_fixed
    y = {s: pulp.LpVariable(f"y_{s}", 0, 1, "Binary") for s in SHIFTS} if not relax else None
    obj = pulp.lpSum(REG[r] * R[s, r] + OT[r] * O[s, r] for s in SHIFTS for r in RES) \
        + BED_COST * (beds - BED_BASE) + IMG_COST * img + LAB_COST * lab
    m += obj
    cons = {}
    for s in SHIFTS:
        dem = target * (MU[s] + demand_z * SD[s])
        for r in RES:
            eff = PROD[r] * cf_allow * ((1 - ABS[r]) if abs_allow else 1)
            need = dem * (w(s) if r == "Doctor" else 1)
            cons[f"Cover_{s}_{r}"] = eff * (R[s, r] + O[s, r]) >= need
            cons[f"OTcap_{s}_{r}"] = O[s, r] <= OT_CAP * R[s, r]
            if not relax and max_ot_shifts is not None:
                m += O[s, r] <= 10 * y[s]
        bt = bed_target if bed_target is not None else target
        cons[f"Beds_{s}"] = beds * SHIFT_HRS / BH[s] >= bt * (MU[s] + demand_z * SD[s])
        cons[f"Ratio_{s}"] = 2 * (R[s, "Doctor"] + O[s, "Doctor"]) >= R[s, "Nurse"] + O[s, "Nurse"]
        cons[f"MinTech_{s}"] = R[s, "Technician"] + O[s, "Technician"] >= 2
    cons["NightDoc"] = R["Night", "Doctor"] + O["Night", "Doctor"] >= 4
    for r in RES:
        cons[f"Avail_{r}"] = pulp.lpSum(R[s, r] for s in SHIFTS) <= AVAIL[r] + H[r]
    if not relax and max_ot_shifts is not None:
        m += pulp.lpSum(y.values()) <= max_ot_shifts
    for k, c in cons.items():
        m += c, k
    st = m.solve(pulp.PULP_CBC_CMD(msg=0))
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
    return plan

def planned_cost(p):
    staff = sum(REG[r] * p["R"][s, r] + OT[r] * p["O"][s, r] for s in SHIFTS for r in RES)
    return staff + BED_COST * (p["beds"] - BED_BASE) + IMG_COST * p["img"] + LAB_COST * p["lab"]

def random_numbers(n, seed=2026):
    g = np.random.default_rng(seed)
    f = lambda *sh: np.clip(np.round(g.random(sh), 6), 0.000001, 0.999999)
    return {"cm": f(n), "inc": f(n), "incs": f(n),
            "arr": f(n, 3), "bh": f(n, 3),
            "abs": {r: f(n, 3) for r in RES}}

from scipy.stats import norm, binom

def simulate(p, U, div_share, pen_uncov=PEN_UNCOV, pen_div=PEN_DIV, pen_bedhr=PEN_BEDHR,
             mu_mult=1.0, inc_up=INC_UP, inc_p=INC_P, abs_mult=1.0, ot_cap=OT_CAP,
             img_rate=None, lab_rate=None, unavailable=None, target=TARGET):
    n = len(U["cm"])
    cmu = U["cm"]
    cf = np.where(cmu < 0.70, 1.0, np.where(cmu < 0.90, 0.9, 0.8))
    inc = U["inc"] < inc_p
    inc_shift = np.floor(U["incs"] * 3).astype(int)
    out = {k: np.zeros((n, 3)) for k in ["A", "div", "board", "uncov", "surge_cost", "surge_staff",
                                          "served", "bedutil", "diag_block"]}
    for j, s in enumerate(SHIFTS):
        mean = MU[s] * mu_mult * np.where(inc & (inc_shift == j), 1 + inc_up, 1.0)
        sdv = SD[s] * mu_mult * np.where(inc & (inc_shift == j), 1 + inc_up, 1.0)
        A = np.maximum(0, np.floor(norm.ppf(U["arr"][:, j], mean, sdv) + 0.5))
        bh = BH[s] * (1 - BH_VAR + 2 * BH_VAR * U["bh"][:, j])
        B = p["beds"] * SHIFT_HRS / bh
        over = np.maximum(0, A - B)
        div = div_share * over
        board = (1 - div_share) * over * bh
        Rt = A - div
        cap = np.full(n, np.inf); surge_cost = np.zeros(n); surge_staff = np.zeros(n)
        caps_after = []
        for r in RES:
            rostered = p["R"][s, r] + p["O"][s, r]
            if unavailable and r in unavailable:
                rostered = max(0, rostered - unavailable[r].get(s, 0))
            pa = min(1, ABS[r] * abs_mult)
            present = binom.ppf(U["abs"][r][:, j], rostered, 1 - pa) if rostered > 0 else np.zeros(n)
            wgt = w(s) if r == "Doctor" else 1.0
            per = PROD[r] * cf / wgt
            need = np.ceil(Rt / per - 1e-9)
            ot_room = max(0, math.floor(ot_cap * p["R"][s, r] + 1e-9) - p["O"][s, r])
            add = np.clip(need - present, 0, ot_room)
            surge_cost += add * OT[r]; surge_staff += add
            caps_after.append((present + add) * per)
        cap = np.minimum.reduce(caps_after)
        out.setdefault("bind", np.zeros((n, 3), dtype=int))[:, j] = np.argmin(np.vstack(caps_after), axis=0)
        if img_rate or lab_rate:
            cap_d = np.full(n, np.inf)
            if img_rate:
                cap_d = np.minimum(cap_d, (IMG_BASE + IMG_ADD * p["img"]) / (img_rate / cf))
            if lab_rate:
                cap_d = np.minimum(cap_d, (LAB_BASE + LAB_ADD * p["lab"]) / (lab_rate / cf))
            out["diag_block"][:, j] = np.maximum(0, np.minimum(Rt, cap) - cap_d)
            cap = np.minimum(cap, cap_d)
        uncov = np.maximum(0, Rt - cap)
        out["A"][:, j] = A; out["div"][:, j] = div; out["board"][:, j] = board
        out["uncov"][:, j] = uncov; out["surge_cost"][:, j] = surge_cost
        out["surge_staff"][:, j] = surge_staff; out["served"][:, j] = A - div - uncov
        out["bedutil"][:, j] = np.minimum(A * bh, p["beds"] * SHIFT_HRS) / (p["beds"] * SHIFT_HRS)
    base = planned_cost(p)
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
        "total_series": total, "pen_series": pen, "surge_series": out["surge_cost"].sum(1), "_out": out, "cf": cf,
    }
    # overtime days in >1 shift (planned OT shifts + surge shifts)
    planned_ot_shift = np.array([1 if sum(p["O"][s, r] for r in RES) > 0 else 0 for s in SHIFTS])
    ot_shift = ((out["surge_staff"] > 0) | (planned_ot_shift[None, :] > 0)).sum(1)
    res["p_ot_multi"] = (ot_shift > 1).mean()
    res["p_any_ot"] = (ot_shift > 0).mean()
    return res

def calibrate_div_share(U):
    """ASSUMPTION: today's 5.2 diversions/day are caused by bed overflow at 34 beds.
    share = 5.2 / expected daily bed-overflow patients at 34 beds."""
    n = len(U["cm"]); inc = U["inc"] < INC_P; incs = np.floor(U["incs"] * 3).astype(int)
    tot = np.zeros(n)
    for j, s in enumerate(SHIFTS):
        f = np.where(inc & (incs == j), 1 + INC_UP, 1.0)
        A = np.maximum(0, np.floor(norm.ppf(U["arr"][:, j], MU[s] * f, SD[s] * f) + 0.5))
        bh = BH[s] * (1 - BH_VAR + 2 * BH_VAR * U["bh"][:, j])
        tot += np.maximum(0, A - BED_BASE * SHIFT_HRS / bh)
    return 5.2 / tot.mean(), tot.mean()
