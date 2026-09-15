"""Acceptance tests: the refactored engine must reproduce baseline_results.json (Brief section 8).
Tolerance: +/-0.5% on costs, +/-0.002 on rates."""
import json, os, sys

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import engine as E  # noqa: E402

COST_KEYS = ["planned_cost", "exp_surge_ot", "exp_penalty", "exp_total", "p95_total"]
RATE_KEYS = ["coverage", "p_target_day", "p_div_day", "p_ot_multi", "p_any_ot"]
COUNT_KEYS = ["exp_div", "exp_uncov", "exp_board_hrs"]


@pytest.fixture(scope="module")
def U():
    return E.load_random_numbers(os.path.join(ROOT, "random_numbers.csv"))


@pytest.fixture(scope="module")
def base():
    with open(os.path.join(ROOT, "baseline_results.json")) as f:
        return json.load(f)


@pytest.fixture(scope="module")
def share(U):
    return E.calibrate_div_share(U)[0]


@pytest.fixture(scope="module")
def plans():
    return E.strategy_plans()


def test_diversion_share(share, base):
    assert share == pytest.approx(0.3477, abs=1e-4)
    assert share == pytest.approx(base["diversion_share"], rel=1e-9)


def test_default_solve():
    p = E.solve_plan()
    assert p["status"] == "Optimal"
    assert E.planned_cost(p) == pytest.approx(299000)
    assert p["beds"] == 36


def test_target_100_with_hires():
    p = E.solve_plan(target=1.0, hires_allowed=True)
    assert E.planned_cost(p) == pytest.approx(320000)
    assert p["beds"] == 38


@pytest.mark.parametrize("k", ["A", "B", "C", "D"])
def test_rosters(k, plans, base):
    exp = E.plan_from_json(base["strategies"][k])
    got = plans[k]
    assert got["R"] == exp["R"]
    assert got["O"] == exp["O"]
    assert (got["beds"], got["img"], got["lab"]) == (exp["beds"], exp["img"], exp["lab"])


@pytest.mark.parametrize("k", ["A", "B", "C", "D"])
def test_strategy_kpis(k, plans, U, share, base):
    kp = base["strategies"][k]["kpis"]
    res = E.simulate(plans[k], U, share)
    for key in COST_KEYS:
        assert res[key] == pytest.approx(kp[key], rel=0.005), key
    for key in RATE_KEYS:
        assert res[key] == pytest.approx(kp[key], abs=0.002), key
    for key in COUNT_KEYS:
        assert res[key] == pytest.approx(kp[key], rel=0.005, abs=0.01), key
    np.testing.assert_allclose(res["p_fail_shift"], kp["p_fail_shift"], atol=0.002)
    np.testing.assert_allclose(res["bedutil"], kp["bedutil"], atol=0.002)


def test_d_with_evening_doctor_unavailable(U, share):
    res = E.simulate(E.PLAN_D, U, share, unavailable={"Doctor": {"Evening": 1}})
    assert res["exp_total"] == pytest.approx(432895, rel=0.005)


def test_params_match_original_engine(U, share):
    """Refactor check: identical outputs to the untouched original engine."""
    sys.path.insert(0, ROOT)
    import engine_original as O
    E.get_solver()  # cache the solver choice before patching the shared pulp module
    O.pulp.PULP_CBC_CMD = lambda msg=0: E.get_solver()  # same solver as the refactored engine
    for kw in [dict(), dict(target=1.0, abs_allow=True, max_ot_shifts=None)]:
        a, b = E.solve_plan(**kw), O.solve_plan(**kw)
        assert a["R"] == b["R"] and a["O"] == b["O"] and a["beds"] == b["beds"]
    ra = E.simulate(E.PLAN_D, U, share, mu_mult=1.1, abs_mult=2)
    rb = O.simulate(E.PLAN_D, U, share, mu_mult=1.1, abs_mult=2)
    assert ra["exp_total"] == pytest.approx(rb["exp_total"], rel=1e-12)
    assert ra["coverage"] == pytest.approx(rb["coverage"], rel=1e-12)


def test_params_object_changes_results(U, share):
    P = E.Params(PEN_UNCOV=12000)
    r1 = E.simulate(E.PLAN_D, U, share)
    r2 = E.simulate(E.PLAN_D, U, share, P=P)
    assert r2["exp_total"] > r1["exp_total"]
