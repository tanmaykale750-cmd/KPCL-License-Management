"""
Model boundary.

The simulation component (assistant/components/forecasting/licence_ml) ships its own ML module,
`licence_ml.train` (the single gradient-boosted Forecaster and artifacts/forecaster.pkl).
`licence_ml.simulate` imports it at module level only for a type hint. Before anything imports the simulation, this guard
registers an inert stand-in for `licence_ml.train`, so:

  * the real train.py is never imported or executed,
  * forecaster.pkl is never opened (Forecaster.load raises),
  * the PoolSimulator receives the trained ENSEMBLE (components/model_selection) as its forecaster.

`install()` must run before the first `import licence_ml.simulate` (backend/app_services.py does this first).
"""
from __future__ import annotations

import sys
import types

BLOCKED = "licence_ml.train"


class BlockedForecaster:
    """Placeholder for the simulation component's own model. Any attempt to load or use it is refused."""

    BLOCKED = True

    def __init__(self, *a, **k):
        raise RuntimeError("The simulation component's embedded ML model is excluded; the ensemble is the only model.")

    @staticmethod
    def load(*a, **k):
        raise RuntimeError("The simulation component's embedded ML model (forecaster.pkl) is excluded by backend/sim_guard.py.")


def install() -> types.ModuleType:
    mod = sys.modules.get(BLOCKED)
    if mod is not None and getattr(mod, "__kpcl_guard__", False):
        return mod
    if mod is not None:
        raise RuntimeError(f"{BLOCKED} was imported before the guard was installed; refusing to continue.")
    stub = types.ModuleType(BLOCKED)
    stub.__kpcl_guard__ = True
    stub.__doc__ = "Inert stand-in installed by backend/sim_guard.py (the real module is excluded)."
    stub.Forecaster = BlockedForecaster
    sys.modules[BLOCKED] = stub
    return stub


def is_active() -> bool:
    return bool(getattr(sys.modules.get(BLOCKED), "__kpcl_guard__", False))
