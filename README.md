# DoL Meld Solver

Browser-based planner for Final Fantasy XIV gatherer (DoL) melding.

The tool helps you choose gear, targets, food options, and meld strategy, then searches for legal meld plans that meet your goals.
Primarily to be used for theorycrafting what is possible over directly taking the recommendations as a meld set. Please still 
use actual meld guides!

## Features

- Gear-aware meld planning across DoL equipment slots
- Target-based solving (Gathering, Perception, GP)
- Fixed or unfixed food handling, including HQ/NQ behavior
- Saved plan editing/export
- Advanced profile mode for breakpoint-focused planning
- One-click `7.5 Preset` loader (editable JSON at `web/js/presets/current-advanced-preset.json`)

## Run Locally

1. Open a terminal in this folder.
2. Start a static server:

```powershell
python -m http.server 8000
```

3. Visit:

`http://localhost:8000/`

Note: run through HTTP, not `file://`, because the app loads JSON with `fetch()`.

## Data Pipeline

Processed runtime data lives in `data/processed/*.json`.

To rebuild processed data from raw CSV inputs:

```powershell
python scripts/build_data.py
```

Validation:

```powershell
python scripts/validate_data.py
```

## Project Layout

- `index.html` - public app entry
- `web/` - frontend code (UI + solver worker)
- `data/processed/` - runtime JSON consumed by the app
- `scripts/` - data build and validation tooling
- `PLAN.md` - implementation notes/roadmap
