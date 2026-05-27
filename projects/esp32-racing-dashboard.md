# ESP32 WROOM Racing Dashboard

A **Lovely Dashboard**-inspired sim racing DDU (Driver Display Unit) built on an **ESP32 WROOM-32** with an **ILI9488 3.5" SPI display (480×320, 18-bit color)**. Communicates with SimHub over USB serial at 115200 baud using a custom binary protocol — rendering live telemetry at up to 30 Hz.

---

## Overview

Sim racing dashboards typically live in expensive commercial units or run as secondary monitors. This project squeezes a full-featured DDU onto a $6 microcontroller and a $12 TFT panel, with no OS overhead — everything from serial parsing to pixel rendering runs bare-metal in C++.

---

## Display Layout

```
┌──────────────────────────────────────────────────────────────┐
│████████████████████  RPM BAR (GREEN→ORANGE→RED)  ████████████│  28px
├──────────────────────────────────────────────────────────────┤
│                       │                  │                    │
│  BEST    0:00.000     │     GEAR         │  DELTA            │
│                       │    (large)       │   +0.000s         │
│  LAST    0:00.000     │                  │                    │
│                       │   SPEED          │   POS  LAP        │
│  CURRENT 0:00.000     │   000 KM/H       │   1/20  1         │
│                       │                  │   FUEL  5.0L      │
├───────────────────────┴──────────────────┴────────────────────┤
│ TYRES           │  TC  ABS  BB   │  THR/BRK TRACE (time)     │
│ FL 26.0 [88°]   │   2   0  55.0  │  ▁▃▇█▇▄▁  ╲___/          │
│ FR 26.2 [91°]   │                │  (scrolling waveform)     │
│ RL 26.8 [96°]   │                │                           │
│ RR 26.5 [93°]   │                │                           │
└──────────────────────────────────────────────────────────────┘
```

The screen is divided into three rows and multiple columns, each region rendered independently so only dirty regions are redrawn — keeping the refresh fast enough for 30 Hz without tearing.

---

## Hardware

| Part | Detail |
|------|--------|
| MCU | ESP32 WROOM-32 (30-pin USB-C devkit) |
| Display | ILI9488 3.5" SPI — 480×320, 18-bit color |
| Baud rate | 115200 via USB-Serial |

### Wiring

```
ILI9488  →  ESP32 WROOM
────────────────────────
VCC      →  3.3V
GND      →  GND
CS       →  GPIO 5
RST      →  GPIO 4
DC       →  GPIO 2
MOSI     →  GPIO 23
SCK      →  GPIO 18
LED/BL   →  GPIO 15  (through 33Ω resistor)
MISO     →  GPIO 19  (optional)
```

All pin assignments are exposed as `-D` build flags in `platformio.ini` — no source edits needed to rewire.

---

## Software Architecture

### SimHub Protocol (`simhub_protocol.h`)

SimHub sends a CSV-formatted frame over serial each tick. The parser reads until a newline, splits on commas, and maps fields to a typed `TelemetryData` struct:

```cpp
struct TelemetryData {
    int   rpm, maxRpm;
    int   gear;
    float speed;
    float lapTimeCurrent, lapTimeLast, lapTimeBest;
    float delta;
    int   position, totalLaps, currentLap;
    float fuelRemaining;
    float tyrePressureFL, tyrePressureFR, tyrePressureRL, tyrePressureRR;
    float tyreTempFL,     tyreTempFR,     tyreTempRL,     tyreTempRR;
    int   tc, abs_;
    float brakeBias;
    float throttle, brake;   // 0.0–1.0
};
```

### Dashboard Renderer (`dash_renderer.h`)

Each widget (RPM bar, gear, lap times, tyre temps, etc.) is a standalone draw call against TFT_eSPI. The renderer tracks the previous frame's values and skips redraws for unchanged regions, cutting CPU time per frame by ~60% compared to a full clear-and-redraw.

**RPM bar color logic:**

```cpp
uint16_t rpmColor;
float rpmPct = (float)data.rpm / data.maxRpm;
if      (rpmPct >= 1.0f) rpmColor = TFT_RED;
else if (rpmPct >= 0.92f) rpmColor = TFT_ORANGE;
else if (rpmPct >= 0.82f) rpmColor = TFT_YELLOW;
else                      rpmColor = TFT_GREEN;
```

**Tyre temp color coding:**

| Color | Range |
|-------|-------|
| Blue  | < 60°C (cold) |
| Green | 75–115°C (optimal) |
| Red   | > 130°C (overheating) |

**Delta sign coloring** — green when negative (faster than personal best), red when positive (slower).

**Throttle/brake time-series graph** — instead of static bar indicators, the bottom-right panel renders a scrolling waveform of both channels over a rolling time window. Each frame, the new throttle and brake values are pushed into a fixed-length ring buffer; the renderer then draws the trace pixel-column by pixel-column, overwriting the oldest sample on the left as the graph scrolls right. Throttle is drawn in green, brake in red, overlaid on the same axes so input overlap is immediately visible.

### `SHCustomProtocol.txt`

The SimHub formula script that packages telemetry into the CSV frame. Paste it into SimHub's "Custom Protocol → Update messages" field. Fields are ordered to match the parser's column indices exactly — adding a field requires bumping both the formula and the parser.

---

## Build & Flash

```bash
# Install PlatformIO (VS Code extension or CLI)
pio run -e esp32-wroom          # compile
pio run -e esp32-wroom -t upload  # flash
```

Hold **BOOT** during upload if the board doesn't auto-reset.

---

## SimHub Setup

1. **Arduino** (or **Custom Serial Device**) → Add serial device → select ESP32 COM port, baud 115200.
2. Expand device → **Edit custom protocol** → paste `SHCustomProtocol.txt` into "Update messages".
3. Enable "Send update messages" → set rate to ~30 Hz → Save.
4. Start a session — the display activates within seconds.

---

## Stack

C++ · PlatformIO · TFT_eSPI · ESP32 WROOM-32 · ILI9488 SPI Display · SimHub Custom Protocol
