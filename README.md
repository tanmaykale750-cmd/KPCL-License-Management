# KPCL Licence Intelligence — integrated app

| Folder | What it is |
|---|---|
| `frontend/` | The React frontend, behind employee sign-in, with a view per profile, connected to the API |
| `backend/` | Thin API (standard-library HTTP server): employee sign-in, four profiles, permission checks, adapters to the modules |
| `assistant/` | RAG assistant with the trained **ensemble** (`components/model_selection`), the **simulation** (`components/forecasting`, simulation only) and the **recommendation engine** (`components/recommendation_engine`) |

## Run (Windows PowerShell)

```powershell
py -3.13 -m venv .venv ; .\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m backend.server --warm                 # API on http://127.0.0.1:8000
# second terminal
cd frontend ; npm ci ; npm run dev             # app on http://127.0.0.1:5173 (proxies /api to :8000)
```

Production-style: `cd frontend ; npm run build`, then `python -m backend.server` serves the app and API on :8000.

Tests:

```powershell
python -m unittest backend.tests.test_integration -v      # 17 checks: sign-in, four profiles, scopes, team, chat, model boundary
cd assistant ; python -m unittest discover -s tests        # 72 checks incl. tests/test_respond.py (question-specific answers)
cd frontend ; npm test                                      # 41 checks incl. approval tiers and profile scopes
```

---

## 1. Four profiles

The profile comes from the employee record (`backend/data/employees.xlsx`, sheet `User_Admin_Roster`, column
`Role_Category`), never from the browser. `backend/data/org_scope.json` maps each category to a profile and links the
roster's departments, projects and tools to the licence registry and to the ML dataset.

| Profile | Role_Category | Data scope | Lands on |
|---|---|---|---|
| **Admin (Head)** | System Admin | everything | Overview |
| **Department Head** | Department Head | their department | Overview (department) |
| **Project Head** | Project Head | their projects | Projects |
| **Engineer** | Staff Engineer, Project Worker | themselves | My Licences |

### Sign in

Enter Employee ID, work email and designation exactly as in the roster. The sign-in page also lists one demo account
per profile (click to fill; turn off with `KPCL_DEMO_ACCOUNTS=0`).

| Profile | Employee ID | Email | Designation |
|---|---|---|---|
| Admin (Head) | ADM101 | prakash.varma.admin@kpcl.com | Head of IT & Software Assets |
| Admin (Head) | ADM102 | suresh.kulkarni.admin@kpcl.com | IT SAM & License Admin |
| Department Head | DH202 | harish.kulkarni.depthead@kpcl.com | Head, Analysis & CAE |
| Department Head | DH201 | meera.joshi.depthead@kpcl.com | Head, Product R&D |
| Project Head | PH301 | amit.gokhale.projecthead@kpcl.com | Project Head, Compressor Redesign |
| Project Head | PH303 | sneha.bhosale.projecthead@kpcl.com | Project Head, CFD Optimisation |
| Engineer | EMP002 | ananya.patel@kpcl.com | CAE Simulation Specialist |
| Engineer | EMP001 | rahul.sharma@kpcl.com | Senior Mechanical Engineer |

The roster now has 27 people: the original 15 plus five department heads (DH201–DH205), five project heads
(PH301–PH305) and two Product Engineering staff. The dataset has no passwords, so sign-in verifies identity details
against the HR record; production should put SSO in front.

### What each profile sees (views)

| View | Admin (Head) | Department Head | Project Head | Engineer |
|---|---|---|---|---|
| **My Licences** — own licences, how each is obtained, availability of own tools, last logged session, own requests, contacts | | | | ✓ (start page) |
| **Overview** — spend, utilisation, idle, key actions | all departments | own department (others as company totals) | | |
| **Team & Access** — people from the HR roster with their tools, access route and last session; department share of each pool; idle seats; requests | all departments, with filter | own department; can release idle seats | own project team; licences each phase needs vs access arranged; schedule what-if links | |
| **Access Requests** | fulfil approved requests | decide the department's requests | requests tied to own projects | submit and track own |
| **Licence & Project registry** | edit, import, all tabs, audit trail | read-only, department scope; release department seats; approvals | | |
| **Planning Studio** (forecast, options, what-if) | all pools | department's pools | own projects (schedule what-ifs only; no costs) | |
| **Review & Savings** | implement and verify (a different admin verifies) | department view | | |
| Software, Projects, Reports, Other Services | ✓ | department scope | Projects only | |
| Vendors, Settings, approval limits, finance inputs | ✓ | | | |
| **Assistant** (RAG chat) | ✓ | ✓ | ✓ (costs hidden) | ✓ (availability answers) |
| Rupee amounts | ✓ | ✓ | hidden | hidden |

### What each profile may call (enforced by the API, `backend/auth.py`)

| Scope | Admin (Head) | Department Head | Project Head | Engineer |
|---|---|---|---|---|
| `forecast` — ensemble forecast and explanation | ✓ | ✓ | ✓ | ✓ |
| `recommend` — recommendation engine decision | ✓ | ✓ | ✓ (costs stripped) | |
| `optimise` — company-wide cost-risk optimiser | ✓ | | | |
| `simulate` — licence-supply what-ifs (add / remove / temporary) | ✓ | ✓ | | |
| `simulate_plan` — schedule what-ifs (delay / cancel / team size) | ✓ | ✓ | ✓ | |
| `chat` — the assistant | ✓ | ✓ | ✓ | ✓ |
| `costs` — rupee amounts in responses | ✓ | ✓ | | |
| `team` — `/api/team` returns | everyone | their department | their project teams | only themselves (+ contacts) |

### Approval chain for recommendations

| Tier (by annual value, default limits) | Steps, in order |
|---|---|
| 1 — up to ₹10 lakh | Licence administrator (the owning department head may endorse or object) |
| 2 — up to ₹30 lakh | Owning **department head** approves → licence administrator |
| 3 — above ₹30 lakh | Department head → licence administrator → **final sign-off by a second administrator** |

Nobody approves their own submission; the final sign-off must come from a different admin. Access requests:
engineer submits → department head decides → administrator fulfils. Project changes: project head proposes →
department head approves → administrator confirms. Every action is written to the audit trail under the signed-in
employee's name.

## 2. The assistant: one answer per question

**The problem it fixes:** the assistant built one brief per pool and returned it for every question about that pool,
so "why is PF001 ANSYS at risk?", "what options do we have?" and "what should we do?" got identical text.

**Now** (`assistant/rag_chatbot/respond.py`, wired in `chat.py`):

1. **Classify the question** into a type, and pick out its focus (a month, an action asked about, yes/no, "how many").
   A bare "why?" follows the previous answer (after "what should we do" it explains the decision; after a forecast
   it explains the drivers).
2. **Run only the tools that type needs** on the real components: the ensemble's live driver explanation, the
   simulation's costed options, a what-if, cross-pool analytics.
3. **Compose the answer for that question** from the ML forecast and the recommendation engine, always in the same
   skeleton: direct answer → key figures → the sections that answer it → next steps with owners → risks and caveats →
   follow-up questions → sources.

| Question type | Example | Sections |
|---|---|---|
| Why / drivers | Why is PF001 ANSYS at risk? | where the risk is; what pushes demand up that month (model drivers); projects active; how risk is measured; what the engine does with it |
| Forecast | What is the forecast for PF001 ANSYS? / How many licences in December? | forecast by month; trend and peak; drivers; how reliable |
| Recommendation | What should we do about PF001 ANSYS? / Should we use temporary licences? | recommendation with quantities; why (engine's decision replay); what the forecast contributed; policy vs cheapest option; approval route |
| Why this recommendation | Why does the engine recommend this? | decision path ✓/→; evidence; **what would change the recommendation** |
| Options | What options do we have and what do they cost? | options table; trade-offs; policy vs cost-optimal |
| Next steps | What are the next steps for PF001 ANSYS? | action plan with owners and deadline; approval route; checks before committing money |
| What-if | What if we add 2 licences / delay P1419 by 1 month? | before → after; month by month; engine on the scenario; what it means |
| Renewal, overview, portfolio, software, ranking, accuracy, method, definition | | composed from the outputs (no raw document dumps) |

**Tailored to the profile:** a Project Head gets schedule-focused next steps and no rupee amounts; an Engineer gets
an availability answer ("what this means for you": request early, avoid the peak, release idle sessions) instead of
the purchase decision; a Department Head sees which projects in a pool belong to their department; licence what-ifs
run only for profiles allowed to.

**With an LLM** (key in `assistant/.env`), the model gets the question type, the asker's profile and the composed draft
for that exact question, and rewrites it conversationally with citations. Without an LLM the composed answer is shown
as is. Either way the API returns `structured` (sections as JSON) for the web app.

## 3. Model boundary

Forecasts come only from the trained ensemble (`assistant/components/model_selection/artifacts/ensemble/ensemble_forecaster.pkl`).
`backend/sim_guard.py` replaces the simulation component's own ML module (`licence_ml.train`, `forecaster.pkl`) with an inert stub
before the simulation is imported, so that module never runs and its model file is never opened.

## 4. Data links (`backend/data/org_scope.json`)

| Roster department | App department group | ML dataset departments |
|---|---|---|
| Product R&D | Mechanical Design (`design`) | Mechanical Design |
| Analysis & CAE | Simulation & Analysis (`sim`) | CAE & Simulation |
| Tooling & Plant | Manufacturing Engineering (`mfg`) | Manufacturing Engineering |
| Electrical & Embedded | Research & Development (`rnd`) | Electrical Design, R&D |
| Product Engineering | Product Engineering (`engg`) | Product Engineering |
| IT & SAM, Engineering Ops | IT & PLM Support (`it`) | — |

Roster projects PRJ-KPCL-01…05 map to the registry's Project X, Fixture library, CFD optimisation, Controller board
and Project Y; primary tools map to registry licences (e.g. ANSYS Mechanical → ANS-MECH) and ML software IDs (SW003).
Department and project heads are linked to the sample dataset's people of the same name, so records already seeded
for them stay theirs. Edit the JSON (not the code) when the organisation changes.
