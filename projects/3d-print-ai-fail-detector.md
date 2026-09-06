<!-- date: ongoing -->

# Argus: AI Print Failure Detection

Camera-based print failure detection for a Voron Trident running Klipper/Moonraker on a Raspberry Pi 5. It watches the print through a webcam, decides whether what it's seeing is a failure in progress, and can pause the printer before a bad print wastes the next several hours of filament and time.

---

## Motivation

The failure mode I actually care about is spaghetti, where the hotend detaches from the print and keeps extruding into open air, sometimes for hours before anyone notices. Catching it early enough to pause the print is the whole point. A false positive costs a 12-hour print just as surely as a real failure does, so precision has to dominate recall. Nearly every design decision in this project traces back to that one tradeoff, more than model architecture ever did.

## How It Works

A single Python process, no firmware or `printer.cfg` changes:

```
Camera frame ──► ONNX model ──► Temporal decision engine ──► Moonraker pause (optional) + Discord notification
```

It talks to Moonraker's REST API rather than Klipper directly, so it's decoupled from the printer's control loop. Runtime dependencies are just `onnxruntime`, OpenCV, numpy, and requests. No `ultralytics`, which is training-time only and never ships to the Pi. Two model paths are interchangeable via config: a YOLO26 object detector and a 6-class classifier.

There are 436 tests, and the whole suite runs offline. No camera, no printer, no network required to validate the decision logic.

## The Decision Engine

A raw per-frame model score is too noisy to act on directly. A single high-confidence frame on a healthy print isn't evidence of anything. Each tick (roughly 1 Hz) runs through a pipeline before anything is allowed to happen:

1. **Hard gates** must be actively printing, past a warmup window (so the purge line and first layer don't trip it), and the frame has to pass a blur/luminance/staleness check.
2. **EMA smoothing** over the raw scores.
3. **K-of-N voting** across a sliding window, so a handful of frames have to agree, not just one.
4. **Two-tier thresholds with hysteresis** and a post-action cooldown, so it doesn't flap.
5. **Severity gating**, where only classes explicitly marked `catastrophic` are even eligible to pause a print.

This part is pinned by tests: 10,000 ticks of realistic nominal noise produce zero false triggers, a sustained failure fires at tick 7, and isolated one- or two-frame confidence spikes are ignored entirely.

The Moonraker client fails closed. Any error talking to the printer returns `UNKNOWN` state, and nothing fires on an unknown state. If Argus can't confirm what the printer is doing, it does nothing.

---

## Where It Actually Got Hard: The Data

The runtime above was the easy part. The data took three separate rounds of fixing, and none of the problems showed up just from looking at the file layout.

**Leakage #1, augmented variants split across train/val.** A Roboflow export had generated three augmented variants per source photo, then split the variants across train and validation independently. 329 of 700 validation images (47%) were near-duplicates of training images. I fixed this by grouping on the source identity encoded in the filename hash before splitting, so all variants of a given source photo land on the same side.

**Leakage #2, silent data loss from mixed annotation formats.** 296 images were being dropped entirely during training with no visible error. Their label files mixed polygon and bounding-box rows, and Ultralytics silently discards the whole image rather than the offending row. I recovered 557 rows by converting the polygon annotations to their bounding boxes.

**Leakage #3, the one that actually mattered.** The best-looking dataset in the pile, 1,912 images from a fixed-camera rig, turned out to be roughly 40 print runs photographed every 30 seconds. Median gap between consecutive frames was 30 seconds, with 98 to 99% of gaps under two minutes. Splitting by individual frame put near-identical images, same print, 30 seconds apart, on both sides of the train/val boundary. A classifier trained on that split scored 97.3% top-1. Re-split by print session instead, the same model scored around 58% early in retraining. That gap was leakage, not model regression.

Two out of two datasets I examined had serious leakage, and neither was visible without checking image similarity and timestamps directly.

---

## Honest Results

**Detection (YOLO26s, 5 classes, held-out test):** overall mAP@50 of 0.195. `spaghetti` specifically: AP50 0.228, with the best real operating point at precision 0.656 / recall 0.065.

**Classification (6 classes):** validation top-1 0.925, test top-1 0.788.

A source-confound check on `spaghetti`, the only class with images pulled from two different datasets, showed recall of 1.000 on images from one source and 0.091 on the other. A 91-point gap on the exact same class means the model was learning which dataset an image came from, not what a spaghetti failure looks like. The pooled precision number was largely an artifact of that confound, not a signal I can trust in production.

So it ships in **notify-only mode.** It reports detections and sends the Discord alert, but nothing it sees today is allowed to touch the print. `spaghetti` is the only class permitted to trigger an auto-cancel path at all, that path is disabled by default, and a test pins it disabled so it can't be quietly re-enabled by an unrelated config change.

The runtime side, the decision engine, the Moonraker integration, the fail-closed behavior, the test suite, is solid and I'd stand behind it in production. The model isn't there yet. It's production-quality plumbing wrapped around a model that isn't ready to make unsupervised decisions.

## What I'd Do Differently

The root cause behind every one of these numbers is domain mismatch: training on other people's printers, cameras, lighting, and bed surfaces, then asking the model to generalize to mine.

- **Record footage from the actual printer.** One fixed camera, one lighting setup, one bed surface is an easier problem than any printer on the internet. I should have started here.
- **Add an anomaly-detection path trained only on healthy frames.** Normal print data is free, since every successful print produces hours of it, while failure data is expensive because you have to deliberately ruin prints to get it.
- **Ensemble the supervised detector and the anomaly path**, and require both to agree before a pause is even considered.
- **Write the `HailoDetector`** for the Raspberry Pi AI HAT+ (26 TOPS). The detector interface is already shaped to support it as a drop-in backend, the driver just doesn't exist yet.

Switching the detection backbone from YOLOv8 to YOLO26 improved mAP by 23% and didn't change the deployability verdict at all. The architecture was never the bottleneck here, the data was.

## Stack

Python 3.10+ · ONNX Runtime · Ultralytics YOLO26 (training only) · OpenCV · Moonraker REST API · systemd · pytest (436 tests)
