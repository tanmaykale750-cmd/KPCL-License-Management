"""train_baseline.py - leak-free baseline + ablation (do the v3 context columns help?).  Run from package root: python code/train_baseline.py"""
import json, warnings, numpy as np, pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor, HistGradientBoostingClassifier
from sklearn.metrics import mean_absolute_error, roc_auc_score
warnings.filterwarnings("ignore")

cfg = json.load(open("ml_config.json"))
df = pd.read_csv("data/licence_cost_forecast_dataset_v3.csv")
for c in cfg["categorical_features"]: df[c] = df[c].astype("category")
FULL = cfg["features"]; OLD = [f for f in FULL if f not in cfg["new_in_v3_features"]]
tr, te, w = df.split == "train", df.split == "test", df.sample_weight

def reg(t, feats):
    m = HistGradientBoostingRegressor(categorical_features="from_dtype", random_state=0).fit(df.loc[tr, feats], df.loc[tr, t], sample_weight=w[tr])
    return mean_absolute_error(df.loc[te, t], m.predict(df.loc[te, feats]))
def clf(t, feats):
    m = HistGradientBoostingClassifier(categorical_features="from_dtype", random_state=0).fit(df.loc[tr, feats], df.loc[tr, t], sample_weight=w[tr])
    return roc_auc_score(df.loc[te, t], m.predict_proba(df.loc[te, feats])[:, 1])

print(f"{'target':38s}{'mean-baseline':>15s}{'old features':>15s}{'+ new columns':>15s}")
for t in ["target_licences_required", "target_portfolio_peak_demand", "target_portfolio_shortfall_licences",
          "target_monthly_licence_cost_inr", "target_cost_optimal_inr", "target_shortfall_cost_optimal_inr", "target_idle_licence_cost_month_inr"]:
    base = mean_absolute_error(df.loc[te, t], np.full(te.sum(), df.loc[tr, t].mean()))
    print(f"{t:38s}{base:>15,.2f}{reg(t, OLD):>15,.2f}{reg(t, FULL):>15,.2f}   (MAE, lower is better)")
t = "target_portfolio_shortfall_flag"
print(f"{t:38s}{'0.500':>15s}{clf(t, OLD):>15.3f}{clf(t, FULL):>15.3f}   (AUC, higher is better; test shortage rate {df.loc[te, t].mean():.1%})")
