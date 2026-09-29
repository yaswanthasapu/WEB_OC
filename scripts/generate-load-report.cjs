const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'loadtest.execution.config.json'), 'utf8').replace(/^\uFEFF/, ''));
const dashboardBrand = config.reports?.dashboardBrand || 'WEB_OC-L1 Dashboard';
const dashboardTitle = config.reports?.dashboardTitle || 'WEB_OC-L1';
const dashboardSubtitle = config.reports?.dashboardSubtitle || 'Load & Performance Report';
const runId = process.env.LOAD_RUN_ID || '';
const dataDirectory = path.join(root, 'reports', 'load-data');
const outputFile = path.resolve(root, config.reports?.crmOutputFile || 'reports/load-report/index.html');
const names = fs.existsSync(dataDirectory) ? fs.readdirSync(dataDirectory) : [];
const summaries = names
  .filter((name) => name.startsWith(`session-${runId}-`) && name.endsWith('.json'))
  .map((name) => JSON.parse(fs.readFileSync(path.join(dataDirectory, name), 'utf8')));
const summary = summaries[0] || {};
const events = summaries.flatMap((summary) => summary.events || []).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
const passed = events.filter(({ status }) => status === 'PASSED').length;
const failed = events.filter(({ status }) => status === 'FAILED').length;
const durations = events.map(({ durationMs }) => Number(durationMs || 0)).sort((a, b) => a - b);
const p50 = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.50) - 1)] : 0;
const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : 0;
const p99 = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.99) - 1)] : 0;
const averageDuration = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0;
const actualDurationMs = summaries.reduce((maximum, summary) => Math.max(maximum, Number(summary.actualDurationMs || 0)), 0);
const throughput = actualDurationMs ? Number(((passed / actualDurationMs) * 60000).toFixed(2)) : 0;
const eventIdGroups = new Map();
for (const event of events) {
  if (!event.eventId) continue;
  if (!eventIdGroups.has(event.eventId)) eventIdGroups.set(event.eventId, []);
  eventIdGroups.get(event.eventId).push(event);
}
const duplicates = [...eventIdGroups.entries()]
  .filter(([, occurrences]) => occurrences.length > 1)
  .map(([eventId, occurrences]) => ({ eventId, occurrences }));
const eventIdsCaptured = eventIdGroups.size > 0;
const mediaRows = events.flatMap((event) => {
  const responses = event.playbackNetwork?.mediaResponses || [];
  const sockets = event.playbackNetwork?.webSockets || [];
  return [
    ...responses.map((response) => ({ event, ...response })),
    ...sockets.map((socket) => ({ event, technology: 'WebSocket', status: socket.error ? 'Error' : 'Active', contentType: '', responseHeaders: {}, ...socket })),
  ];
});

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const formatMs = (value) => `${Number(value || 0).toLocaleString()} ms`;
const formatBytes = (value) => value ? `${(Number(value) / 1048576).toFixed(2)} MB` : 'Unavailable';
const statusClass = (status) => status === 'PASSED' ? 'good' : 'bad';
const successDegrees = events.length ? Math.round((passed / events.length) * 360) : 0;
const donutBackground = events.length
  ? `conic-gradient(var(--green) 0 ${successDegrees}deg,var(--red) ${successDegrees}deg 360deg)`
  : '#dfe5ef';
const chartWidth = 900;
const chartHeight = 210;
const maximumDuration = durations.length ? Math.max(...durations) : 0;
const chartScale = Math.max(1, maximumDuration);
const chartPoints = events.map((event, index) => {
  const x = events.length === 1 ? chartWidth / 2 : (index / Math.max(1, events.length - 1)) * chartWidth;
  const y = chartHeight - ((Number(event.durationMs || 0) / chartScale) * (chartHeight - 25));
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}).join(' ');
const areaPoints = chartPoints ? `0,${chartHeight} ${chartPoints} ${chartWidth},${chartHeight}` : '';

const duplicateCards = duplicates.length ? duplicates.map(({ eventId, occurrences }) => `
  <article class="duplicate-card">
    <div><span class="duplicate-icon">!</span><strong>Event ID ${esc(eventId)}</strong></div>
    <span class="badge bad">${occurrences.length} occurrences</span>
    <div class="occurrences">${occurrences.map((event) => `
      <div>
        <b>Browser session ${esc(event.browserSession || 1)} · Event ${esc(event.eventNumber)}</b>
        <span>${esc(event.action)} · ${esc(event.status)} · ${esc(event.eventType || 'Type unavailable')} · ${esc(event.eventTag || 'Tag unavailable')}</span>
        ${event.screenshot ? `<a href="${esc(event.screenshot)}">View screenshot</a>` : ''}
      </div>`).join('')}
    </div>
  </article>`).join('') : `<div class="empty-state">${eventIdsCaptured ? 'No duplicate Event IDs were detected in this load run.' : 'Event ID collection is disabled for fast execution, so duplicate IDs are not measured.'}</div>`;

const failureRows = events.filter(({ status }) => status === 'FAILED').map((event) => `
  <tr><td>Browser ${esc(event.browserSession || 1)}</td><td>${esc(event.eventId || 'Unavailable')}</td><td>${esc(event.action)}</td><td>${esc(event.slot)}</td><td>${esc(event.error || event.inspectionError || 'Unknown failure')}</td><td>${formatMs(event.durationMs)}</td></tr>`).join('')
  || '<tr><td colspan="6" class="empty-cell">No failed event operations.</td></tr>';

const serverRows = mediaRows.map((row) => {
  const hostname = row.server?.hostname || 'Unavailable';
  const applicationServer = row.responseHeaders?.server || row.responseHeaders?.poweredBy || 'Not exposed';
  return `<tr>
    <td>${esc(row.event.eventId || 'Unavailable')}</td>
    <td>Browser ${esc(row.event.browserSession || 1)}</td>
    <td>${esc(row.technology || 'Unclassified')}</td>
    <td>${esc(hostname)}</td>
    <td>${esc(applicationServer)}</td>
    <td>${esc(row.status)}</td>
    <td>${esc(row.contentType || '—')}</td>
    <td class="url" title="${esc(row.url)}">${esc(row.url || '—')}</td>
  </tr>`;
}).join('') || '<tr><td colspan="8" class="empty-cell">No browser-visible playback server traffic was captured.</td></tr>';

const eventRows = events.map((event) => `<tr>
  <td>${esc(event.eventId || 'Unavailable')}</td><td>Browser ${esc(event.browserSession || 1)}</td><td>${esc(event.eventNumber)}</td>
  <td><span class="badge ${statusClass(event.status)}">${esc(event.status)}</span></td><td>${esc(event.action)}</td>
  <td>${esc(event.eventType || '—')}</td><td>${esc(event.eventTag || '—')}</td><td>${formatMs(event.durationMs)}</td>
</tr>`).join('') || '<tr><td colspan="8" class="empty-cell">No events were processed.</td></tr>';

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>L1 Load Test Dashboard</title>
<style>
:root{--nav:#17213a;--ink:#172033;--muted:#6f7890;--line:#e5e9f2;--panel:#fff;--bg:#f4f7fb;--blue:#356ae6;--green:#20a464;--red:#db3656;--amber:#e99a24}*{box-sizing:border-box}body{margin:0;background:var(--bg);font:14px/1.45 Inter,Segoe UI,Arial,sans-serif;color:var(--ink)}.shell{display:grid;grid-template-columns:220px 1fr;min-height:100vh}.side{background:var(--nav);color:#fff;padding:26px 18px}.brand{font-size:20px;font-weight:800;margin-bottom:35px}.brand span{color:#7fa5ff}.side a{display:block;color:#bec8dc;text-decoration:none;padding:11px 13px;border-radius:8px;margin:5px 0}.side a:hover,.side a.active{background:#263454;color:#fff}.main{padding:28px;overflow:hidden}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px}.top h1{margin:0;font-size:25px}.top p{margin:4px 0 0;color:var(--muted)}.run{background:#e7eefc;color:#2c58be;padding:8px 12px;border-radius:20px;font-weight:700}.kpis{display:grid;grid-template-columns:repeat(4,minmax(160px,1fr));gap:15px}.card,.section{background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 4px 16px #2634540d}.card{padding:18px}.card small{color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.05em}.value{font-size:27px;font-weight:800;margin-top:6px}.section{margin-top:18px;padding:20px}.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.section h2{font-size:17px;margin:0}.grid{display:grid;grid-template-columns:260px 1fr;gap:18px}.donut{width:175px;height:175px;margin:8px auto;border-radius:50%;background:${donutBackground};position:relative}.donut:after{content:'${events.length} events';display:grid;place-items:center;position:absolute;inset:35px;border-radius:50%;background:#fff;font-weight:800}.legend{display:flex;justify-content:center;gap:18px;color:var(--muted)}.dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:6px}.trend svg{width:100%;height:235px;overflow:visible}.trend .area{fill:#356ae626}.trend .line{fill:none;stroke:var(--blue);stroke-width:3}.trend .axis{stroke:#dce2ec;stroke-width:1}.duplicate-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}.duplicate-card{border:1px solid #f2c3cd;border-left:5px solid var(--red);border-radius:10px;padding:15px;background:#fff8fa}.duplicate-card>div:first-child{display:flex;align-items:center;gap:9px}.duplicate-icon{display:grid;place-items:center;width:23px;height:23px;border-radius:50%;background:var(--red);color:#fff;font-weight:900}.duplicate-card>.badge{float:right;margin-top:-24px}.occurrences{margin-top:12px}.occurrences>div{padding:9px 0;border-top:1px solid #f0dce1;display:grid;grid-template-columns:1fr auto;gap:3px}.occurrences span{color:var(--muted);grid-column:1}.occurrences a{grid-column:2;grid-row:1/3;color:var(--blue);text-decoration:none;align-self:center}.badge{display:inline-block;border-radius:14px;padding:4px 9px;font-size:12px;font-weight:800}.good{background:#ddf5e9;color:#147846}.bad{background:#ffe0e7;color:#bb2443}.warn{background:#fff0d6;color:#9f650c}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:9px}table{width:100%;border-collapse:collapse;min-width:780px}th{text-align:left;background:#f8f9fc;color:#68728a;font-size:11px;text-transform:uppercase;letter-spacing:.05em}th,td{padding:11px 13px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}.url{max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.empty-state,.empty-cell{text-align:center;color:var(--muted);padding:26px}.footer{color:var(--muted);text-align:center;margin:24px 0 4px}@media(max-width:980px){.shell{grid-template-columns:1fr}.side{display:none}.kpis{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.main{padding:16px}}
</style></head><body><div class="shell">
<aside class="side"><div class="brand">${esc(dashboardBrand)}</div><a class="active" href="#overview">Overview</a><a href="#duplicates">Duplicates</a><a href="#servers">Video Servers</a><a href="#failures">Failures</a><a href="#events">Event Operations</a></aside>
<main class="main"><header class="top"><div><h1>${esc(dashboardTitle)}</h1><p>${esc(dashboardSubtitle)}</p></div><span class="run">Run ${esc(runId || 'manual')}</span></header>
<section id="overview" class="kpis"><div class="card"><small>Total events</small><div class="value">${events.length}</div></div><div class="card"><small>Passed</small><div class="value" style="color:var(--green)">${passed}</div></div><div class="card"><small>Failed</small><div class="value" style="color:var(--red)">${failed}</div></div><div class="card"><small>Duplicate IDs</small><div class="value" style="color:var(--amber)">${eventIdsCaptured ? duplicates.length : 'N/A'}</div></div><div class="card"><small>Throughput</small><div class="value">${throughput}/min</div></div><div class="card"><small>Average response</small><div class="value">${formatMs(averageDuration)}</div></div><div class="card"><small>p95 response</small><div class="value">${formatMs(p95)}</div></div><div class="card"><small>p99 response</small><div class="value">${formatMs(p99)}</div></div></section>
<section class="grid"><div class="section"><div class="section-head"><h2>Execution status</h2></div><div class="donut"></div><div class="legend"><span><i class="dot" style="background:var(--green)"></i>${passed} passed</span><span><i class="dot" style="background:var(--red)"></i>${failed} failed</span></div></div><div class="section trend"><div class="section-head"><h2>Event response-time trend</h2><span class="badge warn">Maximum ${formatMs(maximumDuration)}</span></div><svg viewBox="0 0 ${chartWidth} ${chartHeight}" preserveAspectRatio="none"><line class="axis" x1="0" y1="${chartHeight}" x2="${chartWidth}" y2="${chartHeight}"/><polygon class="area" points="${areaPoints}"/><polyline class="line" points="${chartPoints}"/></svg></div></section>
<section class="section"><div class="section-head"><h2>Browser Performance Details</h2><span class="badge warn">Single browser</span></div><div class="table-wrap"><table><thead><tr><th>Login</th><th>DNS</th><th>Connection</th><th>TTFB</th><th>DOM ready</th><th>Page load</th><th>Resources</th><th>JS heap used</th></tr></thead><tbody><tr><td>${formatMs(summary.loginDurationMs)}</td><td>${formatMs(summary.browserNavigation?.dnsMs)}</td><td>${formatMs(summary.browserNavigation?.connectionMs)}</td><td>${formatMs(summary.browserNavigation?.ttfbMs)}</td><td>${formatMs(summary.browserNavigation?.domContentLoadedMs)}</td><td>${formatMs(summary.browserNavigation?.loadCompleteMs)}</td><td>${esc(summary.browserRuntime?.resourceCount ?? 0)}</td><td>${formatBytes(summary.browserRuntime?.usedJavaScriptHeapBytes)}</td></tr></tbody></table></div></section>
<section id="duplicates" class="section"><div class="section-head"><h2>Duplicate Events</h2><span class="badge ${duplicates.length ? 'bad' : (eventIdsCaptured ? 'good' : 'warn')}">${eventIdsCaptured ? `${duplicates.length} duplicate Event IDs` : 'Not measured'}</span></div><div class="duplicate-list">${duplicateCards}</div></section>
<section id="servers" class="section"><div class="section-head"><h2>Event Video Server Details</h2><span class="badge warn">${mediaRows.length} browser-visible connections</span></div><div class="table-wrap"><table><thead><tr><th>Event ID</th><th>Browser</th><th>Transport</th><th>Host</th><th>Server header</th><th>Status</th><th>Content type</th><th>Sanitized URL</th></tr></thead><tbody>${serverRows}</tbody></table></div></section>
<section id="failures" class="section"><div class="section-head"><h2>Failures</h2><span class="badge ${failed ? 'bad' : 'good'}">${failed}</span></div><div class="table-wrap"><table><thead><tr><th>Browser</th><th>Event ID</th><th>Action</th><th>Slot</th><th>Reason</th><th>Duration</th></tr></thead><tbody>${failureRows}</tbody></table></div></section>
<section id="events" class="section"><div class="section-head"><h2>All Event Operations</h2></div><div class="table-wrap"><table><thead><tr><th>Event ID</th><th>Browser</th><th>#</th><th>Status</th><th>Action</th><th>Event type</th><th>Event tag</th><th>Duration</th></tr></thead><tbody>${eventRows}</tbody></table></div></section>
<div class="footer">Generated ${esc(new Date().toISOString())} · single-browser sequential load · p50 ${formatMs(p50)}</div></main></div></body></html>`;

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, html);
console.log(`[LOAD] CRM dashboard generated: ${outputFile}`);
