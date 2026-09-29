# Operator Client PWA — L1 Playwright automation

The entire executable workflow and its page-object classes are consolidated in `tests/L1-flow.spec.ts`. There are no additional test specs or separate page-object source files.

## Run

```powershell
npm ci
npx playwright install chromium
.\run-l1.ps1
npm run report
```

Set the URL and true/false execution options in the ignored `execution.config.json`. Login values are optional in the file: leave any of them empty so `run-l1.ps1` asks for the username, mandatory mobile number, and hidden password in the terminal. The suite runs headed and maximized.

The workflow logs in, accepts instructions when shown, waits five seconds for queue population, processes grouped and standalone events, applies the configured action to Site Group children using the live drawer count, acts on the parent, and continues scanning. Missing event choices are reported immediately so they do not add a 15-second delay to every action.

When `reports.playbackNetworkDiagnostics` is `true`, every parent/direct-event Play action captures sanitized network diagnostics. Event Info supplies the Event ID and Live View supplies the Unit ID, so the HTML report groups the JSON and screenshots under names such as `Event ID <event-id> - Unit ID <unit-id> - Site Info Screenshot`, `Event ID <event-id> - Unit ID <unit-id> - Live View Screenshot`, and `Event ID <event-id> - Unit ID <unit-id> - Playback Network Diagnostics`. If Event ID is unavailable, the attachment name falls back to Unit ID. Child events do not create playback-network attachments. The JSON includes Event ID, Event Type/Tag, camera identity, detected video transport, media response status and content type, exposed server headers, failed media requests, WebSocket activity, and `<video>` state. URL credentials, query strings, and fragments are removed. Set `reports.junitStdout` to `false` to remove `<system-out>` from JUnit XML after the run; HTML attachments remain available.

The functional run also generates a customized CRM-style report at `reports/l1-report/index.html` and a downloadable PDF at `reports/l1-report/WEB_OC-L1-report.pdf`. Both reports start with Status, Duration, Events Count, Failures, and Duplicates, then provide Event Evidence screenshots, Event IDs, playback-network details, duplicate attachments, failures and recovery artifacts, recording and trace references, and the execution timeline. The HTML report plays the WebM recording inline; the PDF provides a clickable recording reference. Events Count combines completed parent/direct events with confirmed Site Group child actions, while Duplicates comes from the duplicate-events summary JSON. Use the dashboard's `Download PDF` button or change the path through `reports.pdfOutputFile`. Change report names through `reports.dashboardBrand`, `reports.dashboardTitle`, and `reports.dashboardSubtitle` in `execution.config.json`. The standard Playwright report remains available from the dashboard.

Event IDs are tracked throughout each execution. The HTML report adds a dedicated `Duplicate Events Summary (<count>)` section containing a consolidated JSON summary. Each repeated Event ID appears in that section with a JSON comparison of the first and repeated occurrences and a screenshot of the repeated event. A zero-count summary is included when no duplicates are found.

## Load test

Run `./run-load-test.ps1` to execute `tests/LoadTest.spec.ts` with `loadtest.execution.config.json`. The workflow uses exactly one browser and one Playwright worker; it performs repeated event operations sequentially until the configured duration, event limit, empty queue, or idle limit is reached. Empty credential fields are requested in the terminal, including the hidden password. The load configuration controls duration, maximum events, queue polling, parent delay, empty-queue behavior, and the allowed failure percentage. The browser alternates whole queue events between `escalate` and `terminate`, starting with `alternateActions.startWith`; Event Type/Event Tag rules are not used. Grouped-event children receive the same action as their parent. Event Info is not opened, and Event Type/Event Tag are not read. Event ID is collected passively from WebSocket event data without adding a UI wait. Each transaction triggers playback without waiting for media-control state, captures playback traffic while the action is running, and immediately performs the alternating action. Its JSON summary includes attempted/successful/failed events, throughput per minute, and minimum, average, p50, p95, p99, and maximum response times. The standard Playwright HTML report is written to `playwright-report/load-test`.

Set both `load.durationSeconds` and `load.maxEvents` to `0`, with `load.stopWhenQueueEmpty` set to `true`, to keep processing until all eight exact `No Event Available` markers are visible. A positive value enables that duration or event-count limit.

When the exact empty marker is visible on all eight cards, the load workflow clicks the ToggleSwitch, opens Logout, confirms with `Yes`, and then finishes the browser session.

Queue selection uses a rotating cursor across all eight cards. After processing one slot, the next scan starts at the following slot, which prevents continuously populated top-row cards from blocking actions on the four lower cards.

After the load run, `scripts/generate-load-report.cjs` creates the CRM-style load and performance dashboard at `reports/load-report/index.html`. It provides KPI cards, throughput and percentile timings, pass/fail and response-time charts, a dedicated Duplicate Events section, Event Video Server Details, failures, and all sequential event operations. Server URLs have credentials, query strings, and fragments removed.

Change the CRM report names in `loadtest.execution.config.json` under `reports.dashboardBrand`, `reports.dashboardTitle`, and `reports.dashboardSubtitle`. Event IDs are collected passively from the event WebSocket and matched to the selected card, so the load test does not open Event Info or wait for metadata controls.

## Event action configuration

`execution.config.json` controls the URL, event action, resilience, and report generation for the entire run. Set `eventAction` to `terminate`, `escalate`, or `rule-based`. Rule-based mode logs Event Type, escalates configured Event Tag matches, and terminates everything else. The file remains local and is ignored by Git because it may contain credentials.

```json
{
  "url": "https://uat1-oc.iviscloud.net/",
  "credentials": {
    "username": "",
    "mobileNumber": "",
    "password": ""
  },
  "eventAction": "escalate",
  "terminate": {
    "parentAndStandaloneButton": "False Activity",
    "siteGroupChildButton": "Camera Disconnect"
  },
  "escalate": {
    "parentAndStandaloneButton": "Suspicious Activity",
    "siteGroupChildButton": "Suspicious Activity",
    "childNotes": "Escalated by the automated L1 workflow."
  },
  "resilience": {
    "autoHealElements": true,
    "autoAddNewEvents": true,
    "recoverUserInterference": true
  },
  "reports": {
    "html": true,
    "junit": true,
    "junitStdout": false,
    "trace": true,
    "screenshot": true,
    "video": true,
    "playbackNetworkDiagnostics": true,
    "siteInfoScreenshots": true,
    "liveViewScreenshots": true,
    "fullRunVideo": true
  }
}
```

For Site Group child escalation, the test selects the configured pink reason, fills the configured notes textarea, and clicks the final `Escalate` button. Auto-healing adds title, ARIA-label, visible-text, and media-control fallbacks. Auto-add keeps scanning all eight cards for events that arrive during execution. User-interference recovery captures unexpected dialogs or menus in the report and closes them safely before queue processing continues.

The healing manager classifies timeouts, missing or detached elements, blocking overlays, missing popups, network failures, and closed pages. Safe non-destructive actions receive at most two attempts. Destructive terminate/escalate actions retain their toast, drawer-count, and original-button safeguards. When healing cannot recover, the report receives a screenshot and sanitized `healing-request-*.json` containing the error category, current URL without query parameters, visible page text, suggested recovery, and Playwright MCP handoff details. The automation never commits or pushes a generated repair.

Every Live View click waits two seconds for camera loading, captures a full-page screenshot of the Live View window, and attaches it to the Playwright report under `Live View - Unit ID <unitId>`.

Logout is permitted only when eight visible matches exist for this exact locator:

```xpath
//div[@title='No Event Available']
```

Only after that condition is satisfied does the test print `All cards show No Event Available. ToggleSwitch clicked.` and continue through Logout, Confirm Logout, and Yes.

Generated artifacts:

- HTML report: `playwright-report/index.html`
- JUnit report: `reports/junit.xml`
- Trace: `test-results/**/trace.zip`
- Full automation video: `test-results/**/*.webm`

The functional workflow acts on real UAT events. Review `eventAction` before every run.
