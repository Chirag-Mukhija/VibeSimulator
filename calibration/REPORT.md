# Calibration report

Measured on **Apple M2 (8 cores), darwin 27.0.0**, Node v24.18.0, 2026-10-03.
Regenerate with `pnpm --filter @vibesim/calibration calibrate`; it rewrites `packages/sim/src/params.json` and this file.

The server (`server.mjs`) and the load generator (`client.mjs`) run as separate processes, so client memory never counts against the server. Memory is resident set size (RSS) after two forced garbage collections.

## Fitted parameters

| Parameter | Value | How |
|---|---|---|
| Memory per idle WebSocket | 11.63 KB | slope over 500 / 1,000 / 2,000 connections |
| Memory per open SSE stream | 25.69 KB | same |
| Memory per pending long-poll request | 22.51 KB | same |
| CPU per short-poll request (marginal) | 33.4 µs | line fit over 1,000 / 2,500 / 4,000 req/s, 4 s each, keep-alive |
| Fixed CPU while serving traffic | 6.2% of a core | intercept of the same fit |
| CPU per WebSocket message sent | 4.15 µs | 1,000 clients × 50 broadcasts |
| Idle server RSS | 66.4 MB | after startup |

### CPU fit points

| Rate | CPU | Per request |
|---|---|---|
| 1,000 req/s | 9.2% of a core | 116.0 µs |
| 2,500 req/s | 15.1% of a core | 75.9 µs |
| 4,000 req/s | 19.2% of a core | 60.2 µs |

Per-request cost falls as load rises: event-loop wakeups amortize over more requests, and macOS moves a busier process from the M-series efficiency cores to the faster performance cores. A fixed-plus-marginal line captures that over this range.

### Memory fit points

| Style | Connections | RSS delta | Heap + external delta |
|---|---|---|---|
| ws | 500 | 8.3 MB | 1.5 MB |
| ws | 1,000 | 14.2 MB | 2.9 MB |
| ws | 2,000 | 20.6 MB | 5.2 MB |
| sse | 500 | 9.9 MB | 2.9 MB |
| sse | 1,000 | 26.7 MB | 5.5 MB |
| sse | 2,000 | 50.0 MB | 10.5 MB |
| longpoll | 500 | 9.7 MB | 2.5 MB |
| longpoll | 1,000 | 24.1 MB | 5.0 MB |
| longpoll | 2,000 | 43.2 MB | 9.5 MB |

## Held-out validation (gate: within ±25%)

| Check | Measured | Simulator predicts | Error |
|---|---|---|---|
| ws memory, 3000 connections | 29.63 MB | 34.07 MB | +15.0% |
| sse memory, 3000 connections | 74.55 MB | 75.26 MB | +1.0% |
| longpoll memory, 3000 connections | 66.06 MB | 65.95 MB | -0.2% |
| short polling CPU at 1,500 req/s | 12.00 % of a core | 11.17 % of a core | -7.0% |
| short polling CPU at 3,000 req/s | 17.04 % of a core | 16.18 % of a core | -5.0% |
| WebSocket push CPU, 2,000 clients × 20 messages | 201.75 ms CPU | 166.00 ms CPU | -17.7% |

**Result: PASS.**

## What this does not cover

These numbers are for one small Node process on this machine. Real deployments add TLS (more memory and CPU per connection), larger messages, proxies and other hardware. The Learn pages say so next to every simulated number.
