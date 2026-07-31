<!-- date: TODO -->

# ML Fitness Tracker

A wrist-worn activity recognition system that classifies exercises in real time using sensor fusion across accelerometer and gyroscope streams — no GPS, no camera, no cloud.

---

## Goal

Build a fitness tracker that can distinguish between 8 exercise types (running, walking, cycling, weightlifting variants, rest) using only the inertial sensors available on a low-cost microcontroller, at battery-friendly inference rates.

## Sensor Fusion Pipeline

Raw IMU data is noisy and each axis tells an incomplete story. The pipeline fuses signals before feeding the classifier:

```
Accel (x,y,z) ──┐
                 ├──► Complementary Filter ──► Fused orientation
Gyro  (x,y,z) ──┘                             + gravity removal

Fused signal ──► Sliding window (2s, 50% overlap) ──► Feature extraction ──► Classifier
```

**Complementary filter** blends high-pass filtered gyroscope integration (accurate short-term, drifts) with low-pass filtered accelerometer gravity vector (accurate long-term, noisy short-term). Coefficient α = 0.96 tuned empirically.

**Gravity removal** uses the estimated orientation to subtract the static gravity component, leaving only dynamic acceleration.

## Feature Extraction

Each 2-second window (at 100 Hz = 200 samples) produces 42 features:

- Time domain: mean, variance, skewness, kurtosis, zero-crossing rate (per axis × 2 sensors = 30 features)
- Frequency domain: dominant frequency, spectral entropy, power in 0–3 Hz / 3–8 Hz bands (12 features)
- Cross-axis correlation: 3 pairs × 2 sensors (not used in final model — marginal gain, high cost)

## Classifier

An ensemble of three classifiers, majority-voted:

| Model | CV Accuracy | Notes |
|-------|-------------|-------|
| Random Forest (200 trees) | 91.2% | Best single model |
| Gradient Boosting | 89.7% | Strong on edge classes |
| SVM (RBF kernel) | 87.4% | Fast inference |
| **Ensemble (majority vote)** | **93.6%** | Final deployed model |

Training data: 14 hours of labelled IMU recordings across 4 subjects (including myself), 8 activity classes.

## Confusion Analysis

The hardest pairs to distinguish:

- **Cycling vs. running** at low cadence — both produce ~1.8 Hz dominant frequency; resolved by gyroscope roll variance
- **Dumbbell curl vs. overhead press** — similar wrist path; resolved by pitch trajectory shape (frequency domain)
- **Rest vs. typing** — both low-energy; resolved by zero-crossing rate on the z-axis

## Deployment

The feature extraction and classifier run on a Nordic nRF52840 (Cortex-M4, 64 MHz). The model is exported as a C array via `sklearn` → manual C port of the decision tree ensemble (no ML runtime needed).

Inference runs every 2 seconds; current draw during inference: ~2.4 mA (well within always-on budget at 3V).

## Stack

Python · scikit-learn · NumPy · SciPy · Matplotlib · C (embedded deployment) · nRF SDK
