# Gateway Slice 0 Probe — Tailnet

**Date**: 2026-11-28T00:21:21.615Z
**Method**: This test uses tailnet plain TCP (100.64.x.x), NOT ssh2 reverse tunnel.
**Hub IP**: 100.64.0.3 (Mac tailscale0)
**Tokens**: 200 × 20ms = ~4000ms stream, n=10 median

## Results

| Metric | Local Baseline | Tailnet (local) | Remote | Gate | Result |
|--------|---------------|-----------------|------|------|--------|
| TTFT (ms) | 0 | 0 | — | ≤ baseline + 300ms | ✅ PASS |
| 200-token total (ms) | 4310 | 4321 | — | ≤ baseline × 1.5 | ✅ PASS |
| Abort propagation (ms) | — | 1 | — | ≤ 1000ms | ✅ PASS |
| Token count | 200 | 200 | — | === 200 | ✅ PASS |
| Connection est. (ms) | — | 1 | — | — | — |

## Raw data (sorted)

- Local TTFT: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
- Local total: [4275, 4288, 4290, 4300, 4303, 4310, 4310, 4318, 4319, 4338]
- Local tokens: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200]
- Tailnet TTFT: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
- Tailnet total: [4296, 4299, 4317, 4318, 4318, 4321, 4323, 4331, 4332, 4340]
- Tailnet tokens: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200]
- Conn times: [0, 1, 1, 1, 1, 1, 1, 1, 1, 1]

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
