"""Builds the data files that the web page uses, from the real model in engine.py.

The web page cannot run the LP solver, so this script solves every plan once and saves the answers:
  - plans A, B, C for every 1% step of "extra patients" (-10..+30) and "overtime allowed" (0..50)
  - the fix for the recommended plan when 1-3 staff of any type are missing in any shift
Identical plans are stored once and referred to by number, which keeps the file small.
It also saves the 2,000 simulated days, the case inputs and the Excel answers used for the self-check.

Run again only if the model changes:  python build_data.py
"""
import json, os, sys, time
from dataclasses import asdict

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data")
sys.path.insert(0, HERE)
import engine as E  # noqa: E402

S, R = E.SHIFTS, E.RES
EXTRA = range(-10, 31)      # more or fewer patients, % (1% steps)
OVERTIME = range(0, 51)     # most overtime allowed, % (1% steps)
FIX_KEYS = [f"{r}|{s}|{n}" for r in R for s in S for n in (1, 2, 3)]


def pack(p):
    if p.get("status") != "Optimal":
        return None
    d = {"R": [int(p["R"][s, r]) for s in S for r in R], "O": [int(p["O"][s, r]) for s in S for r in R],
         "beds": int(p["beds"]), "img": int(p["img"]), "lab": int(p["lab"])}
    if p.get("repair") == "partial":
        d["partial"] = 1
    return d


def write(name, var, obj):
    with open(os.path.join(OUT, name), "w") as f:
        f.write(f"// Made by model/build_data.py - do not edit by hand.\nwindow.{var} = ")
        json.dump(obj, f, separators=(",", ":"))
        f.write(";\n")


def main():
    os.makedirs(OUT, exist_ok=True)
    started = time.time()
    unique, seen, index = [], {}, {}

    def ref(plan):
        d = pack(plan)
        if d is None:
            return -1
        k = json.dumps(d, sort_keys=True)
        if k not in seen:
            seen[k] = len(unique)
            unique.append(d)
        return seen[k]

    for extra in EXTRA:
        for ot in OVERTIME:
            P = E.Params(MU_MULT=1 + extra / 100, OT_CAP=ot / 100)
            sp = E.strategy_plans(P)
            index[f"{extra}|{ot}"] = [ref(sp[k]) for k in "ABC"] + [
                ref(E.revise_plan(sp["D"], {r: {s: n}}, P=P)) for r in R for s in S for n in (1, 2, 3)]

    # plans.js rebuilds the same MC_PLANS object the page has always used: {"extra|ot": {A, B, C, fix}}
    with open(os.path.join(OUT, "plans.js"), "w") as f:
        f.write("// Made by model/build_data.py - do not edit by hand.\n"
                "window.MC_PLANS = (function (list, index, fixKeys) {\n"
                "  const get = i => (i < 0 ? null : list[i]), out = {};\n"
                "  for (const key in index) {\n"
                "    const ids = index[key], fix = {};\n"
                "    fixKeys.forEach((k, n) => { fix[k] = get(ids[3 + n]); });\n"
                "    out[key] = { A: get(ids[0]), B: get(ids[1]), C: get(ids[2]), fix };\n"
                "  }\n"
                "  return out;\n"
                "})(")
        for part in (unique, index, FIX_KEYS):
            json.dump(part, f, separators=(",", ":"))
            f.write(",\n" if part is not FIX_KEYS else "")
        f.write(");\n")

    df = pd.read_csv(os.path.join(HERE, "random_numbers.csv"))
    write("days.js", "MC_DAYS", {c: [round(float(v), 6) for v in df[c]] for c in df.columns if c != "day"})

    params = asdict(E.DEFAULT)
    params["D"] = pack(E.PLAN_D)
    write("params.js", "MC_PARAMS", params)

    with open(os.path.join(HERE, "baseline_results.json")) as f:
        base = json.load(f)
    write("baseline.js", "MC_BASELINE", {k: v["kpis"] for k, v in base["strategies"].items()})
    print(f"Wrote {len(index)} settings ({len(unique)} different plans) in {time.time() - started:.0f}s "
          f"to {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
