# Stock Market Tracker

A C++ desktop application for real-time equity market monitoring — live data feeds from Yahoo Finance via `libcurl`, a custom ImGui candlestick chart renderer, CSV parsing with regex, and a Catch2-validated test suite.

---

## Motivation

Most stock dashboards are Python (slow to start) or browser-based (heavy). I wanted something that launches in under 50 ms, stays under 30 MB of RAM, and renders 60 FPS charts without a runtime dependency. C++ with Dear ImGui was the obvious choice.

---

## Architecture

The application is built around four primary components:

1. **Web Scraper** — `libcurl` wrapper fetches real-time OHLCV data from Yahoo Finance over HTTPS.
2. **CSV Parser** — regex-based parser extracts date, open, high, low, close, and volume from the response.
3. **GUI & Chart Renderer** — Dear ImGui with custom candlestick plot extensions.
4. **Stock Selector** — input panel for symbol entry, date range selection, and watchlist management.

### Threading Model

```
Yahoo Finance API (HTTPS)
        │
        ▼
  libcurl fetch thread ──► CSV parser ──► Ring buffer (lock-free SPSC)
                                                 │
                                          Render thread ──► ImGui draw list ──► OpenGL
                                                 │
                                           Main thread ──► Event loop / input
```

Three threads with a single-producer/single-consumer ring buffer between the fetch and render threads — no mutex in the hot path.

---

## Technical Implementation

### Web Scraper

A custom `CurlWrapper` class abstracts libcurl's C API into an object-oriented interface:

```cpp
// URL generation (validated by unit tests)
std::string CurlWrapper::generateURL(const std::string& symbol,
                                      const std::string& startDate,
                                      const std::string& endDate);
```

SSL support was added via `libcurl` + `libssl` in the build configuration:

```dockerfile
RUN apt-get update && apt-get install -y curl libssl-dev
```

### CSV Parser

The Yahoo Finance response is a CSV. The parser uses `std::regex` to extract each field per row, handling edge cases like missing values and adjusted close columns:

```cpp
// Extracts: date, open, high, low, close, volume
// Handles malformed rows gracefully (skips rather than crashes)
```

### Custom Candlestick Renderer

ImGui's `ImDrawList` API exposes raw triangle and line primitives. The candlestick renderer builds on top:

```cpp
void RenderCandle(ImDrawList* dl, float x, float open, float high,
                  float low, float close, float width) {
    bool bullish = close >= open;
    ImU32 color  = bullish ? BULL_COLOR : BEAR_COLOR;
    // Body rect
    dl->AddRectFilled({x - width/2, open}, {x + width/2, close}, color);
    // High/low wick
    dl->AddLine({x, high}, {x, low}, color, 1.0f);
}
```

Since ImPlot did not natively support candlestick charts at the time, I extended it with custom plot blocks integrated into the existing rendering pipeline. Viewport culling ensures only visible candles are drawn — performance is flat regardless of history length.

### Indicators

SMA(20), SMA(50), EMA(12/26), RSI(14), and Bollinger Bands are computed on the parsed dataset and overlaid as separate draw-list passes.

---

## Testing

Comprehensive unit tests use the **Catch2** framework to validate critical paths:

```cpp
TEST_CASE("URL Generation") {
    CurlWrapper curl;
    REQUIRE(curl.generateURL("AAPL", startDate, endDate) == expectedURL);
}
```

Tests cover URL construction, CSV edge cases, and ring-buffer thread safety under simulated concurrent access.

---

## Performance

| Metric | Value |
|--------|-------|
| Startup time (cold) | 38 ms |
| Steady-state RAM | 24 MB |
| Render latency (P99) | 11 ms |
| API fetch latency (P95) | 180 ms |
| CPU usage (idle, 60 FPS) | 1.8% (Ryzen 5 5600X) |

---

## Key Technical Challenges

**Parsing without heap churn** — switched from `nlohmann/json` (allocates heavily per parse) to direct `std::regex` on the CSV stream, cutting fetch-thread allocations by ~70%.

**Scroll + zoom precision** — at 1-minute resolution over 6 months (~260k candles), float32 x-coordinates lose sub-pixel precision. Fixed by using an integer anchor candle index and computing pixel offsets as scaled integer deltas.

**Font rendering at high DPI** — ImGui's default font atlas is too coarse for a data-dense UI. Integrated FreeType backend with a custom atlas for subpixel-accurate text.

---

## Stack

C++ 17 · Dear ImGui · ImPlot (extended) · OpenGL 3.3 · GLFW · libcurl · OpenSSL · std::regex · Catch2 · FreeType · Docker (build environment)
