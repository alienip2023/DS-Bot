# Gateway Slice 0 Probe — Tailnet

**Date**: 2026-11-23T19:54:18.800Z
**Method**: This test uses tailnet plain TCP (100.64.x.x), NOT ssh2 reverse tunnel.
**Hub IP**: 100.64.0.3 (Mac tailscale0)
**Tokens**: 200 × 20ms = ~4000ms stream, n=10 median

## Results

| Metric | Local Baseline | Tailnet (local) | Remote | Gate | Result |
|--------|---------------|-----------------|------|------|--------|
| TTFT (ms) | 0 | 0 | — | ≤ baseline + 300ms | ✅ PASS |
| 200-token total (ms) | 4178 | 4178 | — | ≤ baseline × 1.5 | ✅ PASS |
| Abort propagation (ms) | — | 3 | — | ≤ 1000ms | ✅ PASS |
| Token count | 200 | 200 | — | === 200 | ✅ PASS |
| Connection est. (ms) | — | 2 | — | — | — |

## Raw data (sorted)

- Local TTFT: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1]
- Local total: [4123, 4129, 4157, 4168, 4178, 4178, 4181, 4187, 4189, 4190]
- Local tokens: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200]
- Tailnet TTFT: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
- Tailnet total: [4166, 4169, 4169, 4171, 4173, 4178, 4179, 4182, 4182, 4184]
- Tailnet tokens: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200]
- Conn times: [1, 2, 2, 2, 2, 2, 2, 2, 2, 3]

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
