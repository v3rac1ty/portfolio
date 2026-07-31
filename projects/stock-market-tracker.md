<!-- date: 05-23-2026 -->

# Stock Market Tracker

A C++ desktop application for real-time equity market monitoring - live OHLCV data from the Yahoo Finance JSON API via `libcurl`, a custom ImPlot candlestick renderer, five toggleable technical indicators, and a Catch2-validated test suite.

---

## Motivation

Most stock dashboards are Python (slow to start) or browser-based (heavy). I wanted something that launches in under 50 ms, stays under 30 MB of RAM, and renders 60 FPS charts without a runtime dependency. C++ with Dear ImGui was the obvious choice.

---

## Architecture

The application is built around three primary components:

1. **YahooProvider** - `libcurl` wrapper that hits the Yahoo Finance v8 JSON API (`/v8/finance/chart/{symbol}`), parses the OHLCV response with `nlohmann/json`, and skips null rows from partial trading days.
2. **StockTracker** - worker-thread manager and indicator engine. Accepts async fetch requests via a `std::condition_variable` task queue and exposes static indicator methods callable without a network connection.
3. **Render loop** - Dear ImGui + ImPlot UI running on the main thread at 60 FPS. Reads completed fetch results from the lock-free ring buffer without ever blocking.

### Threading Model

```
Yahoo Finance v8 JSON API (HTTPS)
        │
        ▼
  Worker thread (StockTracker::workerLoop)
    ├── libcurl HTTP GET
    └── nlohmann/json parse → StockInfo
        │
        ▼
  RingBuffer<StockInfo, 8>   ← lock-free SPSC
        │
        ▼
  Render thread (main)
    ├── g_ring.pop() each frame
    ├── DrawCandlestickChart()  → ImPlot draw list
    └── DrawRSIChart()          → ImPlot sub-chart
```

Two threads, zero mutexes in the hot path.

---

## Technical Implementation

### Lock-Free SPSC Ring Buffer

The fetch result crosses from the worker thread to the render thread through a hand-written lock-free ring buffer (`include/ring_buffer.hpp`). Head and tail atomics are placed on separate 64-byte cache lines with `alignas(64)` to prevent false sharing. `push` uses release ordering on the head store; `pop` uses acquire on the head load - the minimal fence pair for a correct SPSC queue.

```cpp
template<typename T, size_t Capacity>
class RingBuffer {
    alignas(64) std::atomic<size_t> m_head{0};
    alignas(64) std::atomic<size_t> m_tail{0};
    std::array<T, Capacity> m_data{};
public:
    bool push(T item) noexcept;        // producer - returns false when full
    std::optional<T> pop() noexcept;   // consumer - returns nullopt when empty
};
```

No allocations, no locks, no spin on the render thread - `pop` returns immediately every frame whether data is ready or not.

### Yahoo Finance v8 JSON API

Rather than scraping HTML or using the v7 CSV download (which requires a session crumb), the data provider hits the v8 chart endpoint directly:

```
GET https://query1.finance.yahoo.com/v8/finance/chart/AAPL
    ?range=1mo&interval=1d&includePrePost=false
```

The response is a JSON object containing parallel arrays for timestamps and OHLCV values. `nlohmann/json` navigates the nested structure; any row with a null close is dropped rather than propagated as a zero.

### Custom Candlestick Renderer

ImPlot's native API doesn't expose per-bar OHLC primitives. The candlestick chart is built on top of `ImPlot::GetPlotDrawList()` and `ImPlot::PlotToPixels()`, converting data-space coordinates to pixel-space before issuing `ImDrawList` calls:

```cpp
ImVec2 bodyL = ImPlot::PlotToPixels(c.timestamp - barW / 2.0,
                                     std::max(c.open, c.close));
ImVec2 bodyR = ImPlot::PlotToPixels(c.timestamp + barW / 2.0,
                                     std::min(c.open, c.close));
ImVec2 wickT = ImPlot::PlotToPixels(c.timestamp, c.high);
ImVec2 wickB = ImPlot::PlotToPixels(c.timestamp, c.low);

if (std::abs(bodyR.y - bodyL.y) < 1.0f)
    bodyR.y = bodyL.y + 1.0f;   // minimum 1px body - doji candles stay visible

dl->AddRectFilled(bodyL, bodyR, col);
dl->AddLine({midX, wickT.y}, {midX, bodyL.y}, col, 1.5f);
dl->AddLine({midX, bodyR.y}, {midX, wickB.y}, col, 1.5f);
```

Bull candles are rendered green (`IM_COL32(0, 197, 105, 255)`), bear candles red. Bar width scales automatically with the selected time range.

### Technical Indicators

All five indicators are implemented as `static` methods on `StockTracker` - no instance, no network call, directly unit-testable:

| Indicator | Algorithm |
|---|---|
| SMA(20), SMA(50) | Sliding window sum, O(n) time, O(1) extra space |
| EMA(12), EMA(26) | Seeded from SMA, multiplier `k = 2/(period+1)` |
| Bollinger Bands | SMA middle band + population std dev x 2 for upper/lower |
| RSI(14) | Wilder smoothing - seed avgGain/avgLoss over first 14 deltas, then `(period-1)/period` decay |

RSI is rendered in a separate sub-chart below the candlesticks, with overbought (>70) and oversold (<30) zones shaded via `AddRectFilled` on the plot's draw list.

---

## Testing

Eight Catch2 test cases cover the full non-UI surface:

| Test | What it checks |
|---|---|
| `YahooProvider URL building` | Correct endpoint, query params, percent-encoding of symbols with spaces (`BRK B` → `BRK%20B`) |
| `YahooProvider JSON parsing` | Happy path (3 candles), null-row skipping, empty/malformed input returns empty vector |
| `StockTracker::computeSMA` | Sliding-window values and NaN prefix for positions before the first full window |
| `StockTracker::computeEMA` | Seed value, multiplier, first step after seed |
| `StockTracker::computeRSI` | NaN prefix length equals period, first valid value in [0, 100] |
| `StockTracker::computeBollinger` | Middle == SMA, bands are symmetric, bandwidth == 2·σ·multiplier |
| `RingBuffer` single-threaded | FIFO order, capacity enforcement, push succeeds after pop |
| `RingBuffer` SPSC stress | 1000 in-order messages across producer/consumer threads with `std::atomic` counters |

The static indicator design means test cases compute SMA over a `vector<CandleData>` and assert exact floating-point values - no mocking, no thread setup, no network.

---

## Stack

C++17 · Dear ImGui v1.91.6 · ImPlot v0.17 · OpenGL 3.3 Core · GLFW 3.4 · libcurl · nlohmann/json v3.11.3 · Catch2 v3.7.1 · CMake 3.20+ (FetchContent)