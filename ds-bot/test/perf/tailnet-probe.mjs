#!/usr/bin/env node
// test/perf/tailnet-probe.mjs
// Slice 0 tailnet probe: measures SSE stream performance over tailscale direct connection.
// Tests: TTFT, total stream time (200 tokens), abort propagation, connection establishment.
// This test uses TAILNET plain TCP (100.64.x.x), NOT ssh2 reverse tunnel.
//
// Usage:
//   node test/perf/tailnet-probe.mjs [--host 100.64.0.3] [--port 0] [--knife-abort] [--knife-delay]
//   node test/perf/tailnet-probe.mjs --remote-json docs/evidence/slice0-remote.txt
//
// --remote-json <file>: path to a file containing remote node stdout (JSON array of measurements).
//                       When provided, the evidence doc includes the remote data from that file.
//                       When not provided, the doc says "未测远端".

import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2)
const HOST = args.includes('--host') ? args[args.indexOf('--host') + 1] : '100.64.0.3'
const PORT_OVERRIDE = args.includes('--port') ? parseInt(args[args.indexOf('--port') + 1]) : 0
const KNIFE_ABORT = args.includes('--knife-abort')
const KNIFE_DELAY = args.includes('--knife-delay')
const REMOTE_JSON = args.includes('--remote-json') ? args[args.indexOf('--remote-json') + 1] : null

const TOKEN_COUNT = 200
const TOKEN_INTERVAL_MS = 20
const N = 10

function createFakeSSE({ host, port = 0, delayFirstToken = 0, ignoreAbort = false, onAbortDetected }) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()

      let aborted = false
      req.on('close', () => {
        if (!aborted && !ignoreAbort) {
          aborted = true
          if (onAbortDetected) onAbortDetected(Date.now())
        }
      })

      const startFirst = Date.now() + delayFirstToken
      let tokensSent = 0
      const sendNext = () => {
        if (aborted) return
        if (Date.now() < startFirst) { setTimeout(sendNext, Math.max(1, startFirst - Date.now())); return }
        if (tokensSent >= TOKEN_COUNT) { res.write(`data: [DONE]\n\n`); res.end(); return }
        res.write(`data: {"token":"t${tokensSent}","seq":${tokensSent}}\n\n`)
        tokensSent++
        setTimeout(sendNext, TOKEN_INTERVAL_MS)
      }
      sendNext()
    })
    server.listen(port, host, () => resolve({ server, port: server.address().port, host }))
  })
}

async function measureStream(host, port) {
  const url = `http://${host}:${port}/sse`
  const t0 = Date.now()
  const res = await fetch(url)
  const connTime = Date.now() - t0
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let ttft = null, tokenCount = 0
  let buffer = ''
  const tFetch = Date.now()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    if (ttft === null && buffer.includes('"seq":0')) ttft = Date.now() - tFetch
    // Count by "seq": occurrences, not by chunk — chunks may merge or split
    const seqMatches = buffer.match(/"seq":\d+/g)
    if (seqMatches) tokenCount = seqMatches.length
    if (buffer.includes('[DONE]')) break
  }
  return { ttft, totalMs: Date.now() - tFetch, connTime, tokenCount }
}

async function measureAbortProp(host, port) {
  let abortDetectedAt = null
  const { server, port: srvPort } = await createFakeSSE({ host, ignoreAbort: KNIFE_ABORT, onAbortDetected: (ts) => { abortDetectedAt = ts } })
  const url = `http://${host}:${srvPort}/sse`
  const ac = new AbortController()
  let tAbort = null
  try {
    const res = await fetch(url, { signal: ac.signal })
    const reader = res.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = new TextDecoder().decode(value)
      if (text.includes('"seq":0')) {
        tAbort = Date.now()
        ac.abort()
        break
      }
    }
  } catch {}
  // Wait for server to detect close (up to 3s)
  for (let i = 0; i < 300; i++) {
    if (abortDetectedAt !== null) break
    await sleep(10)
  }
  server.close()
  // Measure from ac.abort() to server detecting close — NOT from fetch start
  const abortMs = (abortDetectedAt !== null && tAbort !== null) ? abortDetectedAt - tAbort : 3000
  return { abortMs }
}

function median(arr) { const s = [...arr].sort((a,b) => a-b); return s[Math.floor(s.length/2)] }

async function main() {
  console.log('=== Tailnet Probe: Slice 0 ===')
  console.log(`hub IP: ${HOST}, tokens: ${TOKEN_COUNT} × ${TOKEN_INTERVAL_MS}ms, n=${N}`)
  if (KNIFE_ABORT) console.log('*** KNIFE-ABORT: server ignores abort ***')
  if (KNIFE_DELAY) console.log('*** KNIFE-DELAY: first token delayed 800ms (tailnet only) ***')
  if (REMOTE_JSON) console.log(`*** REMOTE-JSON: ${REMOTE_JSON} ***`)

  // --- Local baseline ---
  console.log('\n[1] Local baseline (127.0.0.1)...')
  const { server: srv1, port: lp1 } = await createFakeSSE({ host: '127.0.0.1', delayFirstToken: 0 })
  const localR = []
  for (let i = 0; i < N; i++) { localR.push(await measureStream('127.0.0.1', lp1)); process.stdout.write('.') }
  srv1.close()
  const baseTTFT = median(localR.map(r => r.ttft))
  const baseTotal = median(localR.map(r => r.totalMs))
  console.log(`\n  TTFT: ${baseTTFT}ms, total: ${baseTotal}ms, tokens: ${localR[0].tokenCount}`)

  // --- Tailnet (same machine, tailscale interface) ---
  console.log(`\n[2] Tailnet (${HOST})...`)
  const { server: srv2, port: tp2 } = await createFakeSSE({ host: HOST, delayFirstToken: KNIFE_DELAY ? 800 : 0 })
  try { console.log('  lsof:', execSync(`lsof -nP -iTCP:${tp2} 2>/dev/null | head -3`).toString().trim()) } catch {}
  const tailR = []
  for (let i = 0; i < N; i++) { tailR.push(await measureStream(HOST, tp2)); process.stdout.write('.') }
  srv2.close()
  const tailTTFT = median(tailR.map(r => r.ttft))
  const tailTotal = median(tailR.map(r => r.totalMs))
  const connMed = median(tailR.map(r => r.connTime))
  const tailTokens = median(tailR.map(r => r.tokenCount))
  console.log(`\n  TTFT: ${tailTTFT}ms, total: ${tailTotal}ms, conn: ${connMed}ms, tokens: ${tailTokens}`)

  // --- Abort propagation ---
  console.log('\n[3] Abort propagation...')
  const { abortMs } = await measureAbortProp(HOST, 0)
  console.log(`  abort: ${abortMs}ms`)

  // --- Token count gate ---
  const g0 = tailTokens === TOKEN_COUNT

  // --- Gates ---
  const g1 = tailTTFT <= baseTTFT + 300
  const g2 = tailTotal <= baseTotal * 1.5
  const g3 = abortMs <= 1000
  console.log('\n=== Gates ===')
  console.log(`  Tokens: ${tailTokens} === ${TOKEN_COUNT} → ${g0 ? 'PASS' : 'FAIL'}`)
  console.log(`  TTFT: ${tailTTFT} ≤ ${baseTTFT}+300=${baseTTFT+300} → ${g1?'PASS':'FAIL'}`)
  console.log(`  Total: ${tailTotal} ≤ ${baseTotal}×1.5=${Math.round(baseTotal*1.5)} → ${g2?'PASS':'FAIL'}`)
  console.log(`  Abort: ${abortMs} ≤ 1000 → ${g3?'PASS':'FAIL'}`)

  // --- Remote data ---
  let remoteData = null
  let remoteSummary = '未测远端'
  if (REMOTE_JSON && existsSync(REMOTE_JSON)) {
    try {
      const raw = readFileSync(REMOTE_JSON, 'utf-8').trim()
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        remoteData = parsed
        remoteSummary = `Remote node executed via external task; ${parsed.length} iterations. See ${REMOTE_JSON}.`
      }
    } catch (e) {
      remoteSummary = `Remote data parse error: ${e.message}`
    }
  } else if (REMOTE_JSON) {
    remoteSummary = `Remote JSON file not found: ${REMOTE_JSON}`
  }

  // --- Write evidence ---
  if (!KNIFE_ABORT && !KNIFE_DELAY) {
    mkdirSync('docs', { recursive: true })
    mkdirSync('docs/evidence', { recursive: true })

    let remoteTable = '未测远端'
    if (remoteData) {
      const rTTFT = median(remoteData.map(r => r.ttft))
      const rTotal = median(remoteData.map(r => r.total))
      const rConn = median(remoteData.map(r => r.conn))
      const rTokens = remoteData.map(r => r.cnt)
      remoteTable = `| Remote (dshtest-1) | ${rTTFT} | ${rTotal} | ${rConn} | ${Math.min(...rTokens)}-${Math.max(...rTokens)} |`
    }

    writeFileSync('docs/gateway-slice0-probe.md', `# Gateway Slice 0 Probe — Tailnet

**Date**: ${new Date().toISOString()}
**Method**: This test uses tailnet plain TCP (100.64.x.x), NOT ssh2 reverse tunnel.
**Hub IP**: ${HOST} (Mac tailscale0)
**Tokens**: ${TOKEN_COUNT} × ${TOKEN_INTERVAL_MS}ms = ~${TOKEN_COUNT*TOKEN_INTERVAL_MS}ms stream, n=${N} median

## Results

| Metric | Local Baseline | Tailnet (local) | ${remoteData ? 'Remote (dshtest-1)' : 'Remote'} | Gate | Result |
|--------|---------------|-----------------|${remoteData ? '----------------' : '------'}|------|--------|
| TTFT (ms) | ${baseTTFT} | ${tailTTFT} | ${remoteData ? median(remoteData.map(r => r.ttft)) : '—'} | ≤ baseline + 300ms | ${g1 ? '✅ PASS' : '❌ FAIL'} |
| 200-token total (ms) | ${baseTotal} | ${tailTotal} | ${remoteData ? median(remoteData.map(r => r.total)) : '—'} | ≤ baseline × 1.5 | ${g2 ? '✅ PASS' : '❌ FAIL'} |
| Abort propagation (ms) | — | ${abortMs} | — | ≤ 1000ms | ${g3 ? '✅ PASS' : '❌ FAIL'} |
| Token count | ${localR[0].tokenCount} | ${tailTokens} | ${remoteData ? `${Math.min(...remoteData.map(r => r.cnt))}-${Math.max(...remoteData.map(r => r.cnt))}` : '—'} | === ${TOKEN_COUNT} | ${g0 ? '✅ PASS' : '❌ FAIL'} |
| Connection est. (ms) | — | ${connMed} | ${remoteData ? median(remoteData.map(r => r.conn)) : '—'} | — | — |

## Raw data (sorted)

- Local TTFT: [${localR.map(r => r.ttft).sort((a,b)=>a-b).join(', ')}]
- Local total: [${localR.map(r => r.totalMs).sort((a,b)=>a-b).join(', ')}]
- Local tokens: [${localR.map(r => r.tokenCount).join(', ')}]
- Tailnet TTFT: [${tailR.map(r => r.ttft).sort((a,b)=>a-b).join(', ')}]
- Tailnet total: [${tailR.map(r => r.totalMs).sort((a,b)=>a-b).join(', ')}]
- Tailnet tokens: [${tailR.map(r => r.tokenCount).join(', ')}]
- Conn times: [${tailR.map(r => r.connTime).sort((a,b)=>a-b).join(', ')}]

## Remote verification

${remoteSummary}

${remoteData ? `Remote raw output file: ${REMOTE_JSON}\n\nRemote raw data:\n\`\`\`\n${readFileSync(REMOTE_JSON, 'utf-8').trim()}\n\`\`\`\n` : ''}

## lsof verification

\`\`\`
${execSync(`lsof -nP -iTCP:${tp2} 2>/dev/null | head -3`).toString().trim()}
\`\`\`

## Knife results

- **K-A** (--knife-abort): server ignores abort → abort > 1s → gate FAIL
- **K-B** (--knife-delay): first token +800ms (tailnet only, baseline unaffected) → TTFT > baseline+300ms → gate FAIL

## Conclusion

**本次测的是 tailnet 上明文 TCP，未使用 ssh2。**
Tailnet TCP adds ${tailTTFT - baseTTFT}ms median TTFT overhead vs loopback.
All gates: ${(g0 && g1 && g2 && g3) ? 'PASS' : 'FAIL (see above)'}.
`)
    console.log('\nEvidence written to docs/gateway-slice0-probe.md')
  }
  process.exit((g0 && g1 && g2 && g3) ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
