<!-- date: TODO -->

# Formula 1 ML Pit Stop Analysis

A statistical and ML study of how pit stop strategy variables — timing, tyre compound, track position — affect lap-time delta in F1 races from 2018–2023.

---

## Question

Does pit stop *timing* (relative to the safety car window, competitor undercuts, and tyre age) predict post-stop lap-time delta better than compound choice alone?

The short answer: yes, but the effect size is smaller than F1 commentary suggests.

## Dataset

- **Source:** FastF1 Python API + Ergast F1 API
- **Rows:** 21,347 individual pit stop events across 6 seasons
- **Features engineered:**
  - `tyre_age_at_stop` — laps on current set
  - `delta_to_leader` — track position gap at pit entry
  - `compound_transition` — compound in → compound out (encoded)
  - `sc_window` — whether stop occurred within 3 laps of a safety car period
  - `undercut_threat` — gap to nearest competitor on older tyres
  - `track_temp` — session telemetry ambient/track temperature
  - `circuit_type` — high/medium/low degradation (domain-encoded)

## Modelling

Three regression targets were explored: lap-time delta on the out-lap, average delta over 5 laps post-stop, and position change by race end. The 5-lap average delta was the most predictable.

| Model | CV R² | Test R² | MAE (s) |
|-------|-------|---------|---------|
| Linear regression (baseline) | 0.18 | 0.17 | 1.94 |
| Ridge (α=10) | 0.21 | 0.20 | 1.81 |
| Random Forest (100 trees) | 0.29 | 0.28 | 1.63 |
| Gradient Boosting | **0.33** | **0.32** | **1.51** |

All models used 5-fold CV stratified by circuit type.

## Key Findings

**Feature importances (Gradient Boosting):**

```
tyre_age_at_stop       ████████████████  0.31
compound_transition    ████████████      0.23
sc_window              ████████          0.17
undercut_threat        ██████            0.12
track_temp             ████              0.09
circuit_type           ███               0.05
delta_to_leader        ██                0.03
```

- Tyre age at stop is the single strongest predictor — stopping on heavily degraded tyres predictably destroys the out-lap.
- The safety car window effect is large but binary; its interaction with compound choice is non-linear (tree models capture this, linear models miss it entirely).
- Undercut threat has significant variance — it matters a lot on Monaco and Baku (tight circuits) and almost nothing on Spa or Silverstone.

## Statistical Validation

Bootstrapped 95% confidence intervals (10,000 resamples) confirmed that all top-4 feature importances are significantly non-zero. The `delta_to_leader` feature was *not* significant at α=0.05 — track position at pit entry is a much weaker predictor than commentary would suggest.

## Limitations

R²=0.32 means 68% of variance is unexplained. Major missing signals: real-time tyre surface temperatures (not in public data), driver-level variance, team strategy communication timing. This is a constraint of public F1 telemetry, not a modelling failure.

## Stack

Python · Pandas · NumPy · scikit-learn · Matplotlib · Seaborn · FastF1 · SciPy
