const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'execution.config.json'), 'utf8').replace(/^\uFEFF/, ''));
const reports = config.reports || {};
const inputFile = path.resolve(root, reports.jsonOutputFile || 'reports/l1-results.json');
const outputFile = path.resolve(root, reports.crmOutputFile || 'reports/l1-report/index.html');
const pdfOutputFile = path.resolve(root, reports.pdfOutputFile || 'reports/l1-report/WEB_OC-L1-report.pdf');
const outputDirectory = path.dirname(outputFile);
const data = fs.existsSync(inputFile)
  ? JSON.parse(fs.readFileSync(inputFile, 'utf8').replace(/^\uFEFF/, ''))
  : { suites: [] };
const brand = reports.dashboardBrand || 'WEB_OC-L1 Dashboard';
const title = reports.dashboardTitle || 'WEB_OC-L1';
const subtitle = reports.dashboardSubtitle || 'Functional Automation Report';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const formatDuration = (milliseconds) => {
  const value = Number(milliseconds || 0);
  if (value < 1000) return `${value} ms`;
  const seconds = Math.round(value / 100) / 10;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
};
const relativeLink = (target) => {
  if (!target) return '#';
  const absolute = path.isAbsolute(target) ? target : path.resolve(root, target);
  return path.relative(outputDirectory, absolute).replace(/\\/g, '/');
};
const embeddedImageSource = (target, contentType = 'image/png') => {
  if (!target) return '';
  try {
    const absolute = path.isAbsolute(target) ? target : path.resolve(root, target);
    return `data:${contentType};base64,${fs.readFileSync(absolute).toString('base64')}`;
  } catch {
    return relativeLink(target);
  }
};
const outputText = (entry) => {
  if (typeof entry === 'string') return entry;
  if (entry?.text) return entry.text;
  if (entry?.buffer) return Buffer.from(entry.buffer, 'base64').toString('utf8');
  return '';
};

const cases = [];
const visitSuite = (suite, ancestors = []) => {
  const suitePath = [...ancestors, suite.title].filter(Boolean);
  for (const spec of suite.specs || []) {
    for (const testCase of spec.tests || []) {
      const result = (testCase.results || []).at(-1) || {};
      cases.push({
        title: spec.title || testCase.title || 'L1 functional workflow',
        suitePath,
        status: result.status || testCase.status || 'unknown',
        duration: result.duration || 0,
        attachments: result.attachments || [],
        stdout: (result.stdout || []).map(outputText).join(''),
        stderr: (result.stderr || []).map(outputText).join(''),
        errors: result.errors || (result.error ? [result.error] : []),
      });
    }
  }
  for (const child of suite.suites || []) visitSuite(child, suitePath);
};
for (const suite of data.suites || []) visitSuite(suite);

const allAttachments = cases.flatMap((testCase) => testCase.attachments.map((attachment) => ({ ...attachment, testTitle: testCase.title })));
const screenshots = allAttachments.filter(({ contentType, name }) => contentType === 'image/png' || /screenshot/i.test(name || ''));
const videos = allAttachments.filter(({ contentType, name }) => contentType === 'video/webm' || /recording|video/i.test(name || ''));
const traces = allAttachments.filter(({ name, path: attachmentPath }) => /trace/i.test(name || '') || /trace\.zip$/i.test(attachmentPath || ''));
const duplicateAttachments = allAttachments.filter(({ name }) => /Duplicate Event/i.test(name || ''));
const healingAttachments = allAttachments.filter(({ name }) => /Healing|Auto recovery/i.test(name || ''));
const playbackAttachments = allAttachments.filter(({ name, contentType }) => /Playback Network Diagnostics/i.test(name || '') || contentType === 'application/json' && /playback-network/i.test(name || ''));
const duplicateSummaryAttachment = duplicateAttachments.find(({ name }) => name === 'Duplicate Events Summary');
let duplicateCount = 0;
if (duplicateSummaryAttachment?.path) {
  try {
    const duplicateSummaryPath = path.isAbsolute(duplicateSummaryAttachment.path)
      ? duplicateSummaryAttachment.path
      : path.resolve(root, duplicateSummaryAttachment.path);
    duplicateCount = Number(JSON.parse(fs.readFileSync(duplicateSummaryPath, 'utf8')).duplicateCount || 0);
  } catch {
    duplicateCount = duplicateAttachments.filter(({ name }) => /occurrence \d+ - Details/i.test(name || '')).length;
  }
}
const statusCounts = cases.reduce((counts, testCase) => {
  counts[testCase.status] = (counts[testCase.status] || 0) + 1;
  return counts;
}, {});
const passed = statusCounts.passed || 0;
const failed = (statusCounts.failed || 0) + (statusCounts.timedOut || 0) + (statusCounts.interrupted || 0);
const totalDuration = cases.reduce((sum, testCase) => sum + Number(testCase.duration || 0), 0);

const playbackReports = playbackAttachments.map((attachment) => {
  try {
    const attachmentPath = path.isAbsolute(attachment.path) ? attachment.path : path.resolve(root, attachment.path);
    return { attachment, data: JSON.parse(fs.readFileSync(attachmentPath, 'utf8')) };
  } catch (error) {
    return { attachment, data: null, error: error.message };
  }
});
const eventIds = new Set(playbackReports.map(({ data: report }) => report?.event?.eventId).filter(Boolean));
const eventGroups = new Map();
for (const attachment of screenshots) {
  const match = String(attachment.name || '').match(/^(Event ID .+? - Unit ID .+?) - (.+)$/);
  const identity = match?.[1] || 'General execution evidence';
  if (!eventGroups.has(identity)) eventGroups.set(identity, []);
  eventGroups.get(identity).push({ ...attachment, evidenceType: match?.[2] || attachment.name || 'Screenshot' });
}
for (const report of playbackReports) {
  const event = report.data?.event || {};
  const identity = event.eventId
    ? `Event ID ${event.eventId} - Unit ID ${event.unitId || 'Unavailable'}`
    : String(report.attachment.name || '').replace(/ - Playback Network Diagnostics$/, '');
  if (!eventGroups.has(identity)) eventGroups.set(identity, []);
  eventGroups.get(identity).push({ ...report.attachment, evidenceType: 'Playback Network Diagnostics' });
}

const logLines = cases.flatMap((testCase) => testCase.stdout.split(/\r?\n/))
  .map((line) => line.trim())
  .filter((line) => line.startsWith('[L1]'));
const parentOrDirectEventCount = logLines.filter((line) => /Queue event \d+ parent\/direct .* completed\./i.test(line)).length;
const childEventCount = logLines.filter((line) => /Confirmed child (?:terminate|escalate|termination|escalation)/i.test(line)).length;
const processedEventCount = parentOrDirectEventCount + childEventCount;
const errors = cases.flatMap((testCase) => [
  ...testCase.errors.map((error) => ({ title: testCase.title, message: error.message || String(error) })),
  ...(testCase.stderr.trim() ? [{ title: testCase.title, message: testCase.stderr.trim() }] : []),
]);
const serverRows = playbackReports.flatMap(({ data: report }) => {
  if (!report) return [];
  const event = report.event || {};
  const responses = report.playback?.mediaResponses || [];
  const sockets = report.playback?.webSockets || [];
  return [
    ...responses.map((response) => ({ event, ...response })),
    ...sockets.map((socket) => ({ event, technology: 'WebSocket', status: socket.error ? 'Error' : 'Active', contentType: '', responseHeaders: {}, ...socket })),
  ];
});

const statusClass = failed ? 'bad' : (passed ? 'good' : 'warn');
const evidenceHtml = eventGroups.size ? [...eventGroups.entries()].map(([identity, attachments]) => `
  <article class="event-card"><div class="event-title"><strong>${esc(identity)}</strong><span>${attachments.length} attachments</span></div>
    <div class="evidence-grid">${attachments.map((attachment) => {
      const href = relativeLink(attachment.path);
      if (attachment.contentType === 'image/png') return `<a class="shot" href="${esc(href)}"><img src="${embeddedImageSource(attachment.path, attachment.contentType)}" alt="${esc(attachment.name)}"><span>${esc(attachment.evidenceType)}</span></a>`;
      return `<a class="file-link" href="${esc(href)}">${esc(attachment.evidenceType)}</a>`;
    }).join('')}</div>
  </article>`).join('') : '<div class="empty">No event evidence was attached.</div>';
const duplicatesHtml = duplicateAttachments.length ? duplicateAttachments.map((attachment) => `
  <a class="duplicate" href="${esc(relativeLink(attachment.path))}"><b>${esc(attachment.name)}</b><span>${esc(attachment.contentType || 'attachment')}</span></a>`).join('')
  : '<div class="empty">No duplicate Event IDs were reported.</div>';
const serverRowsHtml = serverRows.map((row) => `<tr><td>${esc(row.event?.eventId || 'Unavailable')}</td><td>${esc(row.event?.unitId || 'Unavailable')}</td><td>${esc(row.technology || 'Unclassified')}</td><td>${esc(row.server?.hostname || 'Unavailable')}</td><td>${esc(row.responseHeaders?.server || row.responseHeaders?.poweredBy || 'Not exposed')}</td><td>${esc(row.status ?? 'Active')}</td><td class="url" title="${esc(row.url)}">${esc(row.url || '—')}</td></tr>`).join('')
  || '<tr><td colspan="7" class="empty">No playback-server details were captured.</td></tr>';
const failureHtml = errors.length ? errors.map((error) => `<article class="failure"><b>${esc(error.title)}</b><pre>${esc(error.message)}</pre></article>`).join('')
  : '<div class="empty">No functional failures were reported.</div>';
const logsHtml = logLines.length ? logLines.map((line, index) => `<li><span>${index + 1}</span><code>${esc(line.replace(/^\[L1\]\s*/, ''))}</code></li>`).join('')
  : '<li class="empty">No L1 execution log was captured.</li>';
const mediaHtml = videos.length ? videos.map((attachment) => `<div class="media"><h3>${esc(attachment.name)}</h3><video controls preload="metadata" src="${esc(relativeLink(attachment.path))}"></video><a class="recording-link" href="${esc(relativeLink(attachment.path))}">Open full automation recording</a></div>`).join('')
  : '<div class="empty">No full automation recording was attached.</div>';
const traceHtml = traces.length ? traces.map((attachment) => `<a class="button" href="${esc(relativeLink(attachment.path))}">${esc(attachment.name || 'Open trace')}</a>`).join('') : '<span class="muted">No trace attachment.</span>';
const healingHtml = healingAttachments.length ? healingAttachments.map((attachment) => `<a class="file-link" href="${esc(relativeLink(attachment.path))}">${esc(attachment.name)}</a>`).join('') : '<span class="muted">No healing artifacts.</span>';
const standardReportLink = relativeLink(path.join(root, 'playwright-report', 'index.html'));
const pdfReportLink = relativeLink(pdfOutputFile);

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{--nav:#17213a;--ink:#172033;--muted:#6f7890;--line:#e4e9f2;--bg:#f4f7fb;--blue:#356ae6;--green:#20a464;--red:#db3656;--amber:#e99a24}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);font:14px/1.45 Inter,Segoe UI,Arial,sans-serif;color:var(--ink)}.shell{display:grid;grid-template-columns:225px minmax(0,1fr);min-height:100vh}.side{background:var(--nav);color:#fff;padding:26px 18px;position:sticky;top:0;height:100vh;overflow:auto}.brand{font-size:19px;font-weight:850;margin-bottom:32px}.side a{display:block;color:#bec8dc;text-decoration:none;padding:11px 13px;border-radius:8px;margin:4px 0}.side a:hover,.side a.active{background:#293858;color:#fff}.main{padding:28px;min-width:0}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}.top h1{font-size:27px;margin:0}.top p{color:var(--muted);margin:3px 0}.top-actions{display:flex;gap:9px;flex-wrap:wrap;justify-content:flex-end}.button{display:inline-block;background:var(--blue);color:#fff;text-decoration:none;border-radius:8px;padding:9px 13px;font-weight:750}.button.secondary{background:#17213a}.kpis{display:grid;grid-template-columns:repeat(5,minmax(140px,1fr));gap:14px}.card,.panel,.event-card,.failure,.media{background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 5px 16px #1e2b470d}.card{padding:20px;min-height:115px}.card small{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;font-weight:750;letter-spacing:.05em}.value{font-size:28px;font-weight:850;margin-top:10px}.value.good{color:#147846}.value.bad{color:#b52240}.value.warn{color:#9a620b}.detail-section{scroll-margin-top:18px;margin-top:25px}.section-head{display:flex;align-items:end;justify-content:space-between;gap:20px;margin:0 0 12px}.section-head h2{font-size:20px;margin:0}.section-head span,.muted{color:var(--muted)}.event-card{padding:16px;margin-bottom:14px}.event-title{display:flex;justify-content:space-between;gap:15px;margin-bottom:13px}.event-title span{color:var(--muted);font-size:12px}.evidence-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}.shot{display:block;color:var(--ink);text-decoration:none;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:#fff}.shot img{display:block;width:100%;height:155px;object-fit:cover;background:#eef1f6}.shot span{display:block;padding:9px;font-size:12px;font-weight:700}.file-link,.duplicate,.recording-link{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 13px;border:1px solid var(--line);border-radius:8px;color:var(--blue);text-decoration:none;background:#fff}.duplicate{margin-bottom:8px}.duplicate span{color:var(--muted);font-size:12px}.recording-link{margin-top:10px}.table-wrap{overflow:auto;background:#fff;border:1px solid var(--line);border-radius:12px}table{width:100%;border-collapse:collapse;min-width:900px}th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line);font-size:12px}th{background:#f8faff;color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.04em}.url{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.failure{padding:14px;margin-bottom:10px;border-left:4px solid var(--red)}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0;color:#8d1d33}.timeline{list-style:none;padding:0;margin:0;background:#fff;border:1px solid var(--line);border-radius:12px}.timeline li{display:grid;grid-template-columns:40px minmax(0,1fr);gap:10px;padding:10px 14px;border-bottom:1px solid var(--line)}.timeline li:last-child{border-bottom:0}.timeline span{color:var(--muted);font-weight:750}.timeline code{white-space:pre-wrap;overflow-wrap:anywhere}.media{padding:14px;margin-bottom:12px}.media h3{margin:0 0 10px;font-size:14px}.media video{display:block;width:100%;max-height:650px;background:#000;border-radius:8px}.artifact-actions{display:flex;flex-wrap:wrap;gap:10px}.panel{padding:16px}.empty{color:var(--muted);padding:18px;text-align:center}.footer{text-align:center;color:var(--muted);padding:25px 0 4px}@media(max-width:1100px){.kpis{grid-template-columns:repeat(3,1fr)}}@media(max-width:760px){.shell{display:block}.side{display:none}.main{padding:15px}.kpis{grid-template-columns:repeat(2,1fr)}.top{align-items:flex-start;gap:14px;flex-direction:column}.event-title{display:block}.event-title span{display:block;margin-top:4px}}@media print{body{background:#fff;font-size:10px}.side,.top-actions{display:none!important}.shell{display:block;min-height:auto}.main{padding:0}.top{margin-bottom:14px}.top h1{font-size:23px}.kpis{grid-template-columns:repeat(5,1fr);gap:8px}.card{min-height:82px;padding:13px;box-shadow:none}.value{font-size:21px}.detail-section{display:block!important;margin-top:18px;break-before:page}#evidence{break-before:auto;margin-top:18px}.section-head{margin-bottom:8px}.section-head h2{font-size:17px}.event-card,.panel,.failure,.media{box-shadow:none;break-inside:avoid}.evidence-grid{grid-template-columns:repeat(3,1fr);gap:8px}.shot{break-inside:avoid}.shot img{height:125px}.shot span{padding:6px;font-size:9px}.table-wrap{overflow:visible}.table-wrap table{min-width:0;table-layout:fixed}.table-wrap th,.table-wrap td{padding:6px 5px;font-size:8px;overflow-wrap:anywhere}.table-wrap .url{max-width:none;white-space:normal}.media video{display:none}.recording-link{margin-top:0}.timeline li{break-inside:avoid;padding:6px 9px}.footer{padding-top:20px}}
</style></head><body><div class="shell"><aside class="side"><div class="brand">${esc(brand)}</div><a class="active" href="#overview">Overview</a><a href="#evidence">Event Evidence</a><a href="#network">Playback Network</a><a href="#duplicates">Duplicates</a><a href="#failures">Failures</a><a href="#recording">Recording &amp; Trace</a><a href="#timeline">Execution Timeline</a></aside><main class="main">
<header class="top"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div><div class="top-actions"><a class="button secondary" href="${esc(pdfReportLink)}" download>Download PDF</a><a class="button" href="${esc(standardReportLink)}">Open Playwright Report</a></div></header>
<section id="overview" class="kpis"><div class="card"><small>Status</small><div class="value ${statusClass}">${failed ? 'FAILED' : (passed ? 'PASSED' : 'UNKNOWN')}</div></div><div class="card"><small>Duration</small><div class="value">${formatDuration(totalDuration)}</div></div><div class="card"><small>Events Count</small><div class="value">${processedEventCount}</div></div><div class="card"><small>Failures</small><div class="value">${errors.length}</div></div><div class="card"><small>Duplicates</small><div class="value">${duplicateCount}</div></div></section>
<section id="evidence" class="detail-section"><div class="section-head"><h2>Event Evidence</h2><span>${screenshots.length} screenshots · ${eventIds.size} Event IDs</span></div>${evidenceHtml}</section>
<section id="network" class="detail-section"><div class="section-head"><h2>Playback Network Details</h2><span>${playbackAttachments.length} attachments</span></div><div class="table-wrap"><table><thead><tr><th>Event ID</th><th>Unit ID</th><th>Technology</th><th>Host</th><th>Server</th><th>Status</th><th>URL</th></tr></thead><tbody>${serverRowsHtml}</tbody></table></div></section>
<section id="duplicates" class="detail-section"><div class="section-head"><h2>Duplicate Events</h2><span>${duplicateCount} duplicates</span></div><div class="panel">${duplicatesHtml}</div></section>
<section id="failures" class="detail-section"><div class="section-head"><h2>Failures &amp; Recovery</h2><span>${errors.length} failures</span></div>${failureHtml}<div class="artifact-actions">${healingHtml}</div></section>
<section id="recording" class="detail-section"><div class="section-head"><h2>Recording &amp; Trace</h2><span>${videos.length} videos · ${traces.length} traces</span></div>${mediaHtml}<div class="panel artifact-actions">${traceHtml}<a class="button secondary" href="${esc(standardReportLink)}">Open complete Playwright report</a></div></section>
<section id="timeline" class="detail-section"><div class="section-head"><h2>Execution Timeline</h2><span>${logLines.length} log entries</span></div><ol class="timeline">${logsHtml}</ol></section>
<div class="footer">Generated ${esc(new Date().toISOString())} · WEB_OC-L1 functional automation</div></main></div></body></html>`;

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(outputFile, html);
const renderPdf = async () => {
  const { chromium } = require('playwright');
  fs.mkdirSync(path.dirname(pdfOutputFile), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`file:///${outputFile.replace(/\\/g, '/')}`, { waitUntil: 'load' });
    await page.pdf({
      path: pdfOutputFile,
      format: 'A4',
      landscape: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div style="width:100%;font:9px Arial;color:#6f7890;padding:0 12mm">WEB_OC-L1 Detailed Automation Report</div>',
      footerTemplate: '<div style="width:100%;font:9px Arial;color:#6f7890;padding:0 12mm;text-align:right">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
      margin: { top: '14mm', right: '10mm', bottom: '14mm', left: '10mm' },
    });
  } finally {
    await browser.close();
  }
};

renderPdf()
  .then(() => {
    console.log(`[L1] CRM dashboard generated: ${outputFile}`);
    console.log(`[L1] PDF report generated: ${pdfOutputFile}`);
  })
  .catch((error) => {
    console.error(`[L1] PDF report generation failed: ${error.message}`);
    process.exitCode = 1;
  });
