// Shared WebSocket streams — ONE connection each for telemetry (/ws/metrics) and logs (/ws/logs),
// multiplexed to every subscriber (Dashboard, Logs page, navbar badges). Avoids each view opening its
// own duplicate socket. Connections are app-lifetime (started by AppNav, which is always mounted),
// auto-reconnect, and replay the last telemetry frame to late subscribers so they don't wait a tick.
//
// Usage:  const off = onMetrics(m => ...);  // returns an unsubscribe fn
//         const off = onLogLines(lines => ...);

function makeStream(path, { replayLast = false } = {}) {
  const subs = new Set();
  let ws = null, started = false, retry = null, last = null;

  const open = () => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { ws = new WebSocket(`${proto}//${window.location.host}${path}`); }
    catch { scheduleRetry(); return; }
    ws.onmessage = (e) => { for (const cb of subs) { try { cb(e.data); } catch {} } if (replayLast) last = e.data; };
    ws.onclose = () => { ws = null; started = false; scheduleRetry(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  };
  const scheduleRetry = () => { clearTimeout(retry); retry = setTimeout(() => { started = false; connect(); }, 5000); };
  const connect = () => { if (started) return; started = true; open(); };

  const subscribe = (cb) => {
    subs.add(cb);
    if (replayLast && last != null) { try { cb(last); } catch {} }
    connect();
    return () => subs.delete(cb);
  };
  return { subscribe, connect };
}

const metricsStream = makeStream('/ws/metrics', { replayLast: true });
const logsStream    = makeStream('/ws/logs');

// The server replays its history buffer only on socket CONNECT. Since the shared socket connects once
// (at app start), keep a rolling line buffer here so a late subscriber (Logs page opened later) still
// gets history via replay. Capped to bound memory.
const LOG_CAP = 1000;
const logBuf = [];
logsStream.subscribe((data) => {
  const lines = String(data).split('\n').filter((l) => l.trim() !== '');
  logBuf.push(...lines);
  if (logBuf.length > LOG_CAP) logBuf.splice(0, logBuf.length - LOG_CAP);
});

// Telemetry: subscriber receives the parsed metrics object per frame.
export function onMetrics(cb) {
  return metricsStream.subscribe((data) => { let m; try { m = JSON.parse(data); } catch { return; } cb(m); });
}
// Logs: subscriber receives an array of non-empty raw log lines per frame. Pass {replay:true} to also
// receive the buffered history immediately (for the Logs page); omit it for live-only (badge counting).
export function onLogLines(cb, { replay = false } = {}) {
  if (replay && logBuf.length) { try { cb(logBuf.slice()); } catch {} }
  return logsStream.subscribe((data) => { cb(String(data).split('\n').filter((l) => l.trim() !== '')); });
}
// Start both connections eagerly (call once from the always-mounted navbar).
export function startStreams() { metricsStream.connect(); logsStream.connect(); }
