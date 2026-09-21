# Operator Client PWA — L1 Playwright automation

The entire executable workflow and its page-object classes are consolidated in `tests/L1-flow.spec.ts`. There are no additional test specs or separate page-object source files.

## Run

```powershell
npm ci
npx playwright install chromium
.\run-l1.ps1
npm run report
```

`run-l1.ps1` loads the ignored `credentials.local.json` file when present and otherwise prompts for the username and hidden password. The suite runs headed, maximized Chromium with tracing enabled and records every run at 1920×1080. It produces HTML and JUnit reports without a named Playwright project badge.

The workflow logs in, accepts instructions when shown, waits five seconds for queue population, processes grouped and standalone events, applies the configured action to Site Group children using the live drawer count, acts on the parent, and continues scanning. Missing event choices are reported immediately so they do not add a 15-second delay to every action.

## Event action configuration

`execution.config.json` controls the action for the entire run. Set `eventAction` to `terminate` or `escalate`. The matching section supplies the button title for standalone/parent events and Site Group children.

```json
{
  "eventAction": "terminate",
  "terminate": {
    "parentAndStandaloneButton": "False Activity",
    "siteGroupChildButton": "Camera Disconnect"
  },
  "escalate": {
    "parentAndStandaloneButton": "Suspicious Activity",
    "siteGroupChildButton": "Suspicious Activity"
  }
}
```

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

The functional workflow acts on real UAT events. The delivered default is `terminate` with `False Activity` for direct/parent events and `Camera Disconnect` for Site Group children.
