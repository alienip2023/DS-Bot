# Gateway Slice 0 Probe — Tailnet

**Date**: 2026-11-27T18:01:36.695Z
**Method**: This test uses tailnet plain TCP (100.64.x.x), NOT ssh2 reverse tunnel.
**Hub IP**: 100.64.0.3 (Mac tailscale0)
**Tokens**: 200 × 20ms = ~4000ms stream, n=10 median

## Results

| Metric | Local Baseline | Tailnet (local) | Remote | Gate | Result |
|--------|---------------|-----------------|------|------|--------|
| TTFT (ms) | 0 | 0 | — | ≤ baseline + 300ms | ✅ PASS |
| 200-token total (ms) | 4324 | 4346 | — | ≤ baseline × 1.5 | ✅ PASS |
| Abort propagation (ms) | — | 4 | — | ≤ 1000ms | ✅ PASS |
| Token count | 200 | 200 | — | === 200 | ✅ PASS |
| Connection est. (ms) | — | 3 | — | — | — |

## Raw data (sorted)

- Local TTFT: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
- Local total: [4270, 4282, 4314, 4320, 4321, 4324, 4326, 4327, 4327, 4347]
- Local tokens: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200]
- Tailnet TTFT: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
- Tailnet total: [4340, 4343, 4344, 4344, 4346, 4346, 4348, 4353, 4354, 4355]
- Tailnet tokens: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200]
- Conn times: [2, 3, 3, 3, 3, 3, 4, 4, 4, 5]

## Remote verification

未测远端



## lsof verification

```

```

## Knife results

- **K-A** (--knife-abort): server ignores abort → abort > 1s → gate FAIL
- **K-B** (--knife-delay): first token +800ms (tailnet only, baseline unaffected) → TTFT > baseline+300ms → gate FAIL

## Conclusion

**本次测的是 tailnet 上明文 TCP，未使用 ssh2。**
Tailnet TCP adds 0ms median TTFT overhead vs loopback.
All gates: PASS.
