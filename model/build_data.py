"""Builds the data files that the web page uses, from the real model in engine.py.

The web page cannot run the LP solver, so this script solves every plan once and saves the answers:
  - plans A, B, C for each "extra patients" and "overtime allowed" setting
  - the fix for the recommended plan when 1-3 staff of any type are missing in any shift
It also saves the 2,000 simulated days, the case inputs and the Excel answers used for the self-check.

Run again only if the model changes:  python build_data.py
"""
import json, os, sys
from dataclasses import asdict

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data")
sys.path.insert(0, HERE)
import engine as E  # noqa: E402

S, R = E.SHIFTS, E.RES
EXTRA = range(-10, 31, 5)      # more or fewer patients, %
OVERTIME = range(0, 51, 5)     # most overtime allowed, %


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
    plans = {}
    for extra in EXTRA:
        for ot in OVERTIME:
            P = E.Params(MU_MULT=1 + extra / 100, OT_CAP=ot / 100)
            sp = E.strategy_plans(P)
            entry = {k: pack(sp[k]) for k in "ABC"}
            entry["fix"] = {f"{r}|{s}|{n}": pack(E.revise_plan(sp["D"], {r: {s: n}}, P=P))
                            for r in R for s in S for n in (1, 2, 3)}
            plans[f"{extra}|{ot}"] = entry
    write("plans.js", "MC_PLANS", plans)

    df = pd.read_csv(os.path.join(HERE, "random_numbers.csv"))
    write("days.js", "MC_DAYS", {c: [round(float(v), 6) for v in df[c]] for c in df.columns if c != "day"})

    params = asdict(E.DEFAULT)
    params["D"] = pack(E.PLAN_D)
    write("params.js", "MC_PARAMS", params)

    with open(os.path.join(HERE, "baseline_results.json")) as f:
        base = json.load(f)
    write("baseline.js", "MC_BASELINE", {k: v["kpis"] for k, v in base["strategies"].items()})
    print(f"Wrote {len(plans)} settings to {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
