# 3D Print AI Fail Detector

A real-time failure detection system for FDM 3D printers that fuses computer vision with vibration analysis — catching print failures before they waste hours of filament.

---

## The Problem

FDM 3D prints fail in subtle ways: layer delamination, spaghetti extrusion, bed adhesion loss. Visual monitoring alone misses vibration-correlated failures; accelerometer-only approaches generate noisy false positives. I wanted a system that combines both modalities on-device, with no cloud dependency.

## Architecture

The system has two parallel inference paths that are fused at decision time:

**Vision path** — YOLOv8n fine-tuned on a labelled dataset of healthy and failing print frames. The model was pruned and exported to ONNX, running at ~18 FPS on a Raspberry Pi 5 via the ONNX Runtime.

**Vibration path** — A 1D CNN trained on accelerometer time-series windows (50 ms, 200 Hz) captures frequency signatures unique to print failures like layer skipping and extruder grinding.

**Fusion** — A lightweight logistic fusion layer combines the posterior probabilities from each path. This is what drove the 40% false-positive reduction over either model in isolation.

```
Camera ──► YOLOv8n (ONNX) ──► P_vision ─┐
                                          ├──► Fusion Layer ──► Alert / OK
Accel  ──► 1D CNN         ──► P_vibr  ──┘
```

## Dataset

- ~4,200 labelled frames (healthy, stringing, spaghetti, delamination)
- Accelerometer: 90-minute recordings across 12 print jobs, manually segmented
- Data augmentation: random brightness/contrast, Gaussian noise on accelerometer windows

## Results

| Metric | Vision only | Vibration only | Fused |
|--------|-------------|----------------|-------|
| Precision | 0.81 | 0.74 | **0.91** |
| Recall | 0.78 | 0.82 | **0.87** |
| False positives (per hour) | 3.2 | 4.7 | **1.9** |

## On-Device Deployment

The ONNX model runs headless on a Raspberry Pi 5 with a USB accelerometer (ADXL345) and camera module. A small Python daemon polls both inference paths at 10 Hz and triggers a GPIO relay to pause the printer on confirmed failure.

Memory footprint: ~210 MB RSS. Inference latency (P95): 54 ms.

## Key Learnings

- ONNX Runtime's `InferenceSession` with `CPUExecutionProvider` is dramatically faster than PyTorch CPU inference for deployment — worth the export step.
- Fusing two weak classifiers with learned weights consistently outperforms a single stronger model trained on concatenated features.
- Accelerometer placement matters: mounting on the print head vs. the frame produces qualitatively different failure signatures.

## Stack

Python · PyTorch · YOLOv8 · ONNX Runtime · OpenCV · NumPy · Raspberry Pi OS
