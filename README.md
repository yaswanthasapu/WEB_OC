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

When `reports.playbackNetworkDiagnostics` is `true`, every parent/direct-event Play action adds a sanitized JSON attachment to the HTML report. Child events do not create playback-network attachments. The JSON includes Event Type/Tag, card heading, detected video transport, media response status and content type, exposed server headers, failed media requests, WebSocket activity, and `<video>` state. URL credentials, query strings, and fragments are removed. Set `reports.junitStdout` to `false` to remove `<system-out>` from JUnit XML after the run; HTML attachments remain available.

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
