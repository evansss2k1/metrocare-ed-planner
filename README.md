# Metro Care ED Planner

A simple web page that helps decide how many doctors, nurses and technicians the emergency department needs in each
shift. It runs on your own computer. No internet, no Python and no installing are needed to use it.

## How to open it

Double-click **index.html**. It opens in your browser.

## The five screens

1. **Our plan**: the recommended staff, the real daily cost and a short explanation.
2. **Compare plans**: the four plans side by side.
3. **Someone is absent**: what happens if staff are missing, and what to do.
4. **Busy shift check**: enter patients so far and get a Normal / Watch / Surge / Emergency signal.
5. **How it works**: the method in plain words, and a self-check against the Excel model.

## What is inside

| File | What it does |
|---|---|
| `index.html`, `style.css` | The page and its look |
| `app.js` | The screens |
| `simulate.js` | Plays out the 2,000 made-up days (a copy of the simulation in `model/engine.py`) |
| `data/` | The plans, the 2,000 days and the Excel answers, made by `model/build_data.py` |
| `model/` | The real model in Python (the LP that builds the plans) and its tests |

## For the team: checking and rebuilding

Check that the page matches the Excel model (needs Node):

```bash
node model/tests/check_web.js
```

Rebuild the plans after changing the model (needs Python with pulp, highspy, numpy, scipy and pandas):

```bash
cd model && python build_data.py
```

The sliders move in steps of 5% because each setting's plan is solved in advance by the model.
