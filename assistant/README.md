# KPCL Licence Intelligence Assistant

A Streamlit app with a RAG chatbot for engineering-software licence planning. It forecasts each licence pool's
peak demand, explains the forecast, and recommends what to do: buy, use temporary licences, reduce at renewal or
keep. It also explains **why**, step by step. It runs what-if scenarios through the real model, and every answer
cites its sources.

## 1. What is inside

| Folder | What it does |
|---|---|
| `components/model_selection` | Compares several light ML models on the v3 dataset and **uses the most accurate one** (currently a stacked ensemble) |
| `components/forecasting` | Licence-demand dataset, feature pipeline, the original single gradient-boosted model, and the **Monte Carlo simulation** that turns a forecast into shortage risk and costed options |
| `components/recommendation_engine` | **Decision rules** that turn the forecast and usage history into an action per pool, plus a software-level cost-risk optimiser |
| `rag_chatbot/` | Integration, knowledge base, retrieval, recommendation explanations, chat logic, LLM clients |
| `app.py` | Streamlit UI |
| `scripts/` | `build_pipeline.py` (pipeline and health check) and `ask.py` (terminal chat) |
| `tests/` | Test suite |

### How a question is answered

1. **Understand the question.** Pick out the portfolio (PF001), software (ANSYS → SW003), project (P1254)
   and month. A follow-up such as "why?" or "what about MATLAB?" reuses the pool from the previous turn.
2. **Run live tools** on the real components when needed:
   - a model explanation: which factors push demand up or down;
   - a **what-if**, for example "add 2 licences", "3 temporary licences", "delay P1254 by 2 months",
     "cancel P0817" or "team size of P1254 to 20". It is re-simulated, then the decision rules are re-applied;
   - the simulation's option comparison, with costs;
   - exact rankings and counts across all pools.
3. **Explain the recommendation.** `rag_chatbot/explain.py` replays the recommendation engine's decision for the
   pool, in the engine's own order, using its own thresholds and numbers:
   - forecast coverage;
   - the shortage-risk test against the 5% tolerance;
   - the capacity gap;
   - the temporary-vs-permanent cost comparison;
   - the decision rule that fired;
   - the guardrails, such as company-wide demand, Critical software and incomplete forecasts.

   A test checks that this replay reaches the engine's actual action for **all 573 pools**.
4. **Retrieve.** Hybrid BM25 + TF-IDF search, re-ranked by the pool, software, project and type of question.
5. **Answer the question that was asked** (`rag_chatbot/respond.py`). The question is classified first — why /
   drivers, forecast, what to do, why this recommendation, options and costs, next steps, what-if, renewal, ranking,
   accuracy, method, definition — and the answer is composed for that type from the forecast, the simulation and the
   recommendation engine. Every answer has the same skeleton:
   - **Summary** — the direct answer (yes/no first for yes/no questions, the number first for "how many")
   - **Key figures**
   - the sections that answer this question (e.g. the drivers and projects behind the peak for "why is it at risk";
     the options table and trade-offs for "what do the options cost"; the decision path and *what would change the
     recommendation* for "why this recommendation"; an action plan with owners for "next steps")
   - **Next steps** for the asker's profile, with owners
   - **Risks and caveats**, follow-up questions and sources

   The answer is tailored to the asker's profile when it comes through the API (Admin (Head), Department Head,
   Project Head, Engineer: see `rag_chatbot/viewer.py`). With an LLM configured, the model receives the question type,
   the profile and this question-specific draft, and rewrites it from the cited context. Without one, the composed
   answer is shown directly. `tests/test_respond.py` checks that different questions get different answers.

## 2. Forecasting model (selected by accuracy)

The candidates were:

- two simple rules;
- ridge regression and a Poisson GLM;
- k-nearest neighbours;
- a decision tree, random forest and extra trees;
- histogram gradient boosting;
- LightGBM and XGBoost, if installed;
- two ensembles built from the models above.

They were compared with **walk-forward, purged cross-validation**. Training used only labels that had closed by
the 30 Sep 2026 as-of date, and hyperparameters were fixed. The lowest CV error wins. Three tests the selection
never saw were then scored once.

| | Result |
|---|---|
| Selected | Stacked ensemble: gradient boosting 0.49, ridge 0.38, Poisson GLM 0.07, kNN 0.06 |
| CV MAE | 1.222 licences (next best: gradient boosting, 1.227) |
| Test A: known pools, future months | MAE 1.263 (+3.3% vs CV, so no overfitting) |
| Test C: unseen pools, future months | MAE 1.064 |
| Within ±2 licences / shortage AUC / P90 coverage | 87.7% / 0.949 / 85.8% |
| Acceptance checks | 6/6 PASS |

The full leaderboard is in `components/model_selection/reports/ensemble/` and on the app's *Model evidence* page.
To use the single gradient-boosted model instead, set `FORECAST_MODEL=single` in `.env` and run
`python scripts\build_pipeline.py --simulate`.

## 3. Setup on Windows (PowerShell)

You need Python 3.11–3.13. The saved models need scikit-learn 1.9.1, which `requirements.txt` pins.

```powershell
Expand-Archive .\rag_chatbot_complete.zip -DestinationPath .
Set-Location .\rag_chatbot_complete
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env ; notepad .env      # add your LLM key (section 4)
python scripts\build_pipeline.py --check --ping-llm
streamlit run app.py
```

If activation is blocked, run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once.
Streamlit asks for an email the first time it starts; press Enter to skip.

Optional commands:

```powershell
python scripts\build_pipeline.py              # re-sync forecast -> engine, rebuild the knowledge base (~10 s)
python scripts\build_pipeline.py --simulate   # re-run the Monte Carlo simulation of all 573 pools (~3-4 min)
python scripts\build_pipeline.py --retrain    # re-run the model comparison (~2 min) + simulation
python -m pip install lightgbm xgboost        # adds two more candidates to the comparison (then --retrain)
python scripts\ask.py "Why is PF001 ANSYS at risk?"   # terminal chat
```

## 4. LLM / API key

Put **one** provider in `.env`, with each setting on its own line. `LLM_PROVIDER=auto` uses Anthropic if
`ANTHROPIC_API_KEY` is set, otherwise OpenAI-compatible, otherwise no LLM.

**Groq** (OpenAI-compatible). Use a model that your account lists at console.groq.com:
```
LLM_PROVIDER=openai
OPENAI_API_KEY=gsk_...
OPENAI_BASE_URL=https://api.groq.com/openai/v1
OPENAI_MODEL=openai/gpt-oss-120b
MAX_TOKENS=2500
```

**Anthropic:**
```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5-5
```

**OpenAI:**
```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=<a chat model on your account>
```

Make sure each key appears only once in `.env`; a later duplicate line overrides an earlier one.

The check `python scripts\build_pipeline.py --check --ping-llm` sends a 5-token request. Reasoning models such as
`gpt-oss` can return "empty answer" to such a short request even though the key works.

To use fewer tokens, add `TOP_K=5`, `HISTORY_TURNS=3` and `REWRITE_FOLLOWUPS_WITH_LLM=false`.

## 5. Using the app

| Page | What it shows |
|---|---|
| 💬 Assistant | Structured answers with sources, suggested follow-ups, and notes when a tool or the LLM was unavailable |
| 📈 Predictions | The 6-month forecast chart and table for the pool selected in the sidebar. *Run live forecast + explanation* re-runs the model and shows the drivers |
| ✅ Recommendations | Key numbers, then the full structured explanation: summary, forecast, **why this recommendation**, options compared, caveats and next steps |
| 🧪 What-if | Change licences, add temporary licences, delay or cancel not-started projects, or change a team size. The model, the simulation and the decision rules are all re-run |
| 📊 Model evidence | Model comparison, hold-out accuracy and checks, accuracy by software, charts and pipeline status |

Example questions:

- *Why is PF001 ANSYS recommended this action?* → *What if we add 2 licences?* → *What about MATLAB?*
- *What if we delay P1419 by 1 month in PF001 ANSYS?*
- *Which pools are riskiest for Altair HyperWorks?* · *Which pools can be reduced at renewal?*
- *Which model is used and how accurate is it?* · *What does P90 mean?*

## 6. Tests

```powershell
python -m unittest discover -s tests -v
python -m unittest discover -s components\recommendation_engine\tests -v
python components\forecasting\tests\test_pipeline.py
```

Results from the last run before packaging (Linux, Python 3.13, scikit-learn 1.9.1):

| Suite | Result |
|---|---|
| App tests (`tests/`) | **54 tests: 52 passed, 2 skipped.** The 2 skipped are Streamlit `AppTest` UI tests, because Streamlit was not installable in the build sandbox; they run on your machine. |
| Recommendation engine's own tests | 7 / 7 passed |
| Forecasting pipeline's own checks | 9 / 9 passed |

The app tests cover:

- the explanation replay agreeing with the engine on **all 573 pools**;
- every action type producing all answer sections;
- no team-member names anywhere in answers, sources or notes;
- the live model reproducing the saved simulation;
- what-if behaviour;
- retrieval quality;
- the LLM clients, run against a local mock server.

What was not tested in the build environment:

- a real call to Groq, Anthropic or OpenAI (no key was available there);
- rendering in a real Streamlit; app.py was run against a stand-in module instead;
- Windows itself.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `Activate.ps1 is not recognized` | The `.venv` folder isn't there, for example after unzipping into a new folder. Create it again (section 3) |
| "No suitable Python runtime found" | Use a Python version you have: `py -0` lists them, then use e.g. `py -3.13` |
| HTTP 404 "model does not exist" | The model name isn't available to your account. List your models at the provider's console and copy one exactly |
| Answers start with "no AI summary" | No LLM key was found. Check `.env` and run `--check --ping-llm` |
| "trained model could not be loaded" | `pip install scikit-learn==1.9.1`, or `python scripts\build_pipeline.py --retrain` |
| Sidebar warns that the forecast input differs | `python scripts\build_pipeline.py` |

## 8. Limitations

- All usage, prices and inventory are synthetic planning data. Savings and costs are *possible*, and every action
  needs human approval.
- Each portfolio is modelled with the full software licence count, so money is per pool and **not additive** across
  portfolios.
- The decision rules and the simulation can recommend different options for the same pool. The rules apply fixed
  policy thresholds; the simulation picks the cheapest option month by month. Answers show both and explain why
  they differ.
- What-if parsing in chat understands common phrasings. The What-if page supports every option.
