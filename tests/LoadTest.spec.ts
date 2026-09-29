// @ts-nocheck
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const configPath = path.resolve(__dirname, '../loadtest.execution.config.json');
if (!fs.existsSync(configPath)) throw new Error(`Load test configuration was not found: ${configPath}`);
const executionConfig = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
const loadConfig = executionConfig.load || {};
const actionConfig = executionConfig.alternateActions || {};
const loadRunId = process.env.LOAD_RUN_ID || `manual-${Date.now()}`;
const loadDataDirectory = path.resolve(__dirname, '../reports/load-data');
fs.mkdirSync(loadDataDirectory, { recursive: true });

class LoadLoginPage {
  constructor(page) {
    this.page = page;
    this.username = page.locator("//input[@placeholder='Enter your email or username']");
    this.mobileNumber = page.locator([
      "//input[@id='*r_4h3*']",
      "//input[contains(@id,'r_4h3')]",
      "//input[@type='tel']",
      "//input[contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'mobile')]",
    ].join(' | ')).first();
    this.password = page.locator("//input[@placeholder='Enter your password']");
    this.submit = page.locator("//button[@class='submit-button']");
  }

  async login(username, mobileNumber, password) {
    await this.page.goto('/');
    await expect(this.username).toBeVisible();
    await expect(this.mobileNumber).toBeVisible();
    await this.username.fill(username);
    await this.mobileNumber.fill(mobileNumber);
    await this.password.fill(password);
    await this.submit.click();
  }
}

class LoadInstructionsPage {
  constructor(page) {
    this.checkbox = page.getByRole('checkbox', { name: 'I have read and accept the instructions.' });
    this.proceed = page.getByRole('button', { name: 'Accept & Proceed' });
  }

  async acceptIfShown() {
    const visible = await this.checkbox.waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!visible) return;
    await this.checkbox.check();
    await expect(this.proceed).toBeEnabled();
    await this.proceed.click();
  }
}

class LoadEventIdTracker {
  constructor(page) {
    this.records = [];
    page.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => this.recordFrame(payload));
    });
  }

  recordFrame(payload) {
    try {
      const rawPayload = String(payload);
      const message = JSON.parse(rawPayload);
      if (message.type !== 'event' || !message.data) return;
      const data = message.data;
      const exactIdFromPayload = rawPayload.match(/"(?:eventId|eventID|event_id)"\s*:\s*"?(\d{6,})/i)?.[1];
      const eventId = exactIdFromPayload
        || String(data.eventId || data.eventID || data.event_id || data.extras?.eventId || '').trim();
      if (!eventId) return;
      const eventTimeParts = String(data.eventTime || '').split('-');
      this.records.push({
        eventId,
        siteName: String(data.siteName || data.extras?.siteName || '').trim(),
        eventClock: eventTimeParts.length >= 3 ? eventTimeParts.slice(-3).join(':') : '',
      });
      if (this.records.length > 1000) this.records.shift();
    } catch {
      // Ignore video frames and other non-event WebSocket payloads.
    }
  }

  async findForCard(card) {
    const visibleText = await card.innerText().catch(() => '');
    if (!visibleText) return null;
    const normalize = (value) => String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const normalizedText = normalize(visibleText);
    const visibleClock = visibleText.match(/Event\s+(\d{2}:\d{2}:\d{2})/i)?.[1] || '';
    const siteMatches = [];
    const clockMatches = [];
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      const matchesSite = record.siteName && normalizedText.includes(normalize(record.siteName));
      const matchesClock = record.eventClock
        && (visibleClock === record.eventClock || visibleText.includes(record.eventClock));
      if (matchesSite && (!record.eventClock || matchesClock)) return record.eventId;
      if (matchesSite) siteMatches.push(record);
      if (matchesClock) clockMatches.push(record);
    }
    if (clockMatches.length === 1) return clockMatches[0].eventId;
    if (siteMatches.length === 1) return siteMatches[0].eventId;
    return null;
  }
}

class LoadPlaybackNetworkMonitor {
  constructor(page) {
    this.responses = [];
    this.failures = [];
    this.webSockets = [];
    page.on('response', (response) => this.recordResponse(response));
    page.on('requestfailed', (request) => this.recordFailure(request));
    page.on('websocket', (socket) => this.recordWebSocket(socket));
  }

  sanitizedUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      parsed.pathname = parsed.pathname.split('/').map((segment) => (
        segment.length > 48 ? '[redacted]' : segment
      )).join('/');
      return parsed.toString();
    } catch {
      return '[unavailable]';
    }
  }

  serverFromUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      return { protocol: parsed.protocol.replace(':', ''), hostname: parsed.hostname, port: parsed.port || null };
    } catch {
      return { protocol: null, hostname: null, port: null };
    }
  }

  classify(url, contentType = '') {
    const value = `${url} ${contentType}`.toLowerCase();
    if (/\.m3u8\b|mpegurl/.test(value)) return 'HLS';
    if (/\.mpd\b|dash\+xml/.test(value)) return 'MPEG-DASH';
    if (/\.flv\b|video\/x-flv/.test(value)) return 'FLV';
    if (/\.m4s\b/.test(value)) return 'Fragmented MP4';
    if (/\.mp4\b|video\/mp4/.test(value)) return 'MP4';
    if (/\.ts\b|video\/mp2t|mpeg-ts/.test(value)) return 'MPEG-TS';
    if (/video\/webm|\.webm\b/.test(value)) return 'WebM';
    if (/^wss?:/.test(url)) return 'WebSocket';
    if (/video|stream|playback|recording|footage|clip|media/.test(value)) return 'Media API';
    return null;
  }

  recordResponse(response) {
    const headers = response.headers();
    const contentType = headers['content-type'] || '';
    const technology = this.classify(response.url(), contentType);
    if (response.request().resourceType() !== 'media' && !technology && !/video|audio|octet-stream/.test(contentType.toLowerCase())) return;
    this.responses.push({
      timestamp: Date.now(),
      url: this.sanitizedUrl(response.url()),
      server: this.serverFromUrl(response.url()),
      status: response.status(),
      contentType,
      technology: technology || 'Unclassified media',
      responseHeaders: {
        server: headers.server || null,
        via: headers.via || null,
        poweredBy: headers['x-powered-by'] || null,
        cache: headers['x-cache'] || headers['cf-cache-status'] || null,
      },
    });
    if (this.responses.length > 5000) this.responses.shift();
  }

  recordFailure(request) {
    const technology = this.classify(request.url(), '');
    if (request.resourceType() !== 'media' && !technology) return;
    this.failures.push({
      timestamp: Date.now(),
      url: this.sanitizedUrl(request.url()),
      server: this.serverFromUrl(request.url()),
      technology: technology || 'Unclassified media',
      error: request.failure()?.errorText || 'Request failed',
    });
  }

  recordWebSocket(socket) {
    const record = {
      createdAt: Date.now(),
      url: this.sanitizedUrl(socket.url()),
      server: this.serverFromUrl(socket.url()),
      sentFrames: 0,
      receivedFrames: 0,
      lastActivityAt: Date.now(),
    };
    socket.on('framesent', () => { record.sentFrames += 1; record.lastActivityAt = Date.now(); });
    socket.on('framereceived', () => { record.receivedFrames += 1; record.lastActivityAt = Date.now(); });
    this.webSockets.push(record);
  }

  async reportFor(scope, startedAt, endedAt) {
    const mediaResponses = this.responses.filter(({ timestamp }) => timestamp >= startedAt && timestamp <= endedAt);
    const failedMediaRequests = this.failures.filter(({ timestamp }) => timestamp >= startedAt && timestamp <= endedAt);
    const webSockets = this.webSockets.filter(({ createdAt, lastActivityAt }) => createdAt <= endedAt && lastActivityAt >= startedAt);
    const videoElements = await scope.locator('video').evaluateAll((videos) => videos.map((video) => ({
      sourceType: video.srcObject instanceof MediaStream ? 'MediaStream' : (video.currentSrc?.startsWith('blob:') ? 'MediaSource/blob' : 'URL'),
      readyState: video.readyState,
      networkState: video.networkState,
      paused: video.paused,
      width: video.videoWidth,
      height: video.videoHeight,
    }))).catch(() => []);
    const technologies = new Set(mediaResponses.map(({ technology }) => technology));
    if (webSockets.length) technologies.add('WebSocket activity observed');
    return { detectedTechnologies: [...technologies], mediaResponses, failedMediaRequests, webSockets, videoElements };
  }
}

class LoadQueuePage {
  constructor(page) {
    this.page = page;
    this.slots = page.locator('.l1-card-slot');
    this.levelBanner = page.getByText(/^Level:L1\s*\|\s*Queue:/);
    this.emptyMarkers = page.locator("//div[@title='No Event Available']");
    this.selectedCard = null;
    this.siteGroupBadge = null;
    this.drawer = null;
    this.nextCardIndex = 0;
  }

  actionButton(scope, title) {
    return scope.locator(`button[title="${title}"]:not([disabled])`)
      .or(scope.locator(`button[aria-label="${title}"]:not([disabled])`))
      .or(scope.getByRole('button', { name: title, exact: true }))
      .first();
  }

  toast(title) {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.page.getByText(new RegExp(`Event (?:Acknowledged|terminated|escalated):\\s*${escaped}`, 'i')).last();
  }

  async waitUntilReady() {
    await expect(this.page).toHaveURL(/\/levell1\/?(?:[?#].*)?$/, { timeout: 30000 });
    await expect(this.levelBanner).toBeVisible();
    await expect(this.slots).toHaveCount(8);
  }

  async queueIsEmpty() {
    if (await this.emptyMarkers.count() !== 8) return false;
    for (let index = 0; index < 8; index += 1) {
      if (!(await this.emptyMarkers.nth(index).isVisible().catch(() => false))) return false;
    }
    return true;
  }

  async logoutFromEmptyQueue() {
    await expect(this.emptyMarkers, 'All eight No Event Available markers were not present').toHaveCount(8);
    for (let index = 0; index < 8; index += 1) {
      await expect(this.emptyMarkers.nth(index), `No Event Available marker ${index + 1} was not visible`).toBeVisible();
    }
    const toggle = this.page.locator("//input[contains(@class, 'MuiSwitch-input')]").first();
    await expect(toggle, 'ToggleSwitch was not available for empty-queue logout').toBeAttached();
    await expect(toggle).toBeEnabled();
    await toggle.click();

    const logout = this.page.locator("//button[@aria-label='Logout']");
    await expect(logout).toBeVisible();
    await expect(logout).toBeEnabled();
    await logout.click();
    await expect(this.page.locator("//span[text()='Confirm Logout']")).toBeVisible();

    const confirm = this.page.locator("//button[text()='Yes']");
    await expect(confirm).toBeVisible();
    await confirm.click();
    await expect(this.page).toHaveURL(/\/?(?:[?#].*)?$/, { timeout: 10000 });
    console.log('[LOAD][BROWSER] All eight cards show No Event Available. Logout completed.');
  }

  async selectNext(action) {
    const buttonTitle = actionConfig[action]?.parentAndStandaloneButton;
    if (!buttonTitle) throw new Error(`alternateActions.${action}.parentAndStandaloneButton is required.`);
    const count = await this.slots.count();
    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.nextCardIndex + offset) % count;
      const slot = this.slots.nth(index);
      const badge = slot.getByRole('button', { name: /^\d+ same-site events?$/ }).first();
      if (await badge.isVisible().catch(() => false)) {
        this.selectedCard = slot;
        this.siteGroupBadge = badge;
        this.nextCardIndex = (index + 1) % count;
        return { grouped: true, slot: index + 1 };
      }
      if (await this.actionButton(slot, buttonTitle).isVisible().catch(() => false)) {
        this.selectedCard = slot;
        this.siteGroupBadge = null;
        this.nextCardIndex = (index + 1) % count;
        return { grouped: false, slot: index + 1 };
      }
    }
    return null;
  }

  async startPlaybackNetworkCapture() {
    const play = this.selectedCard.locator('button:has(svg path[d="M8 5v14l11-7z"])')
      .or(this.selectedCard.locator('span[aria-label="Play"] button, button[title="Play"]'))
      .first();
    if (await play.isVisible().catch(() => false)) {
      await play.click().catch(() => undefined);
    }
  }

  async openSiteGroup() {
    await this.siteGroupBadge.click();
    const heading = this.page.getByRole('heading', { name: /^Site Grouping/ });
    await expect(heading).toBeVisible();
    this.drawer = this.page.locator('.MuiDrawer-paper').filter({ has: heading });
    await expect(this.drawer).toBeVisible();
  }

  async childCount() {
    const countText = (await this.drawer.getByText(/^\d+ same-site events?$/).first().textContent()) || '';
    const match = countText.trim().match(/^(\d+) same-site events?$/);
    if (!match) throw new Error(`Could not read Site Group child count from "${countText.trim()}".`);
    return Number(match[1]);
  }

  async confirmChildEscalation(notes) {
    const notesBox = this.page.locator("//textarea[contains(@id,'r_12l')]")
      .or(this.page.locator('textarea[placeholder*="note" i], [role="dialog"] textarea'))
      .last();
    await expect(notesBox).toBeVisible({ timeout: Math.max(1000, Number(loadConfig.actionTimeoutMilliseconds || 10000)) });
    await notesBox.fill(notes);
    const confirm = this.page.locator("//button[text()='Escalate']")
      .or(this.page.getByRole('button', { name: 'Escalate', exact: true }))
      .last();
    await expect(confirm).toBeEnabled();
    await confirm.click();
  }

  async processChildren(action) {
    const config = actionConfig[action] || {};
    const title = config.siteGroupChildButton;
    if (!title) throw new Error(`alternateActions.${action}.siteGroupChildButton is required.`);
    let processed = 0;
    let remaining = await this.childCount();
    while (remaining > 0) {
      if (processed >= 50) throw new Error('Site Group exceeded the 50-child safety limit.');
      const before = remaining;
      const button = this.actionButton(this.drawer, title);
      await expect(button).toBeVisible({ timeout: Math.max(1000, Number(loadConfig.actionTimeoutMilliseconds || 10000)) });
      await button.click();
      if (action === 'escalate') {
        await this.confirmChildEscalation(config.childNotes || 'Escalated by the automated L1 load workflow.');
      }
      await expect.poll(() => this.childCount(), {
        timeout: Math.max(1000, Number(loadConfig.actionTimeoutMilliseconds || 10000)),
      }).toBeLessThan(before);
      remaining = await this.childCount();
      processed += 1;
    }
    await this.drawer.getByRole('button', { name: 'close', exact: true }).click();
    await expect(this.drawer).toBeHidden();
    return processed;
  }

  async processParent(action) {
    const title = actionConfig[action]?.parentAndStandaloneButton;
    const button = this.actionButton(this.selectedCard, title);
    await expect(button).toBeVisible({ timeout: Math.max(1000, Number(loadConfig.actionTimeoutMilliseconds || 10000)) });
    const handle = await button.elementHandle();
    await button.click();
    await expect(this.toast(title)).toBeVisible({ timeout: Math.max(1000, Number(loadConfig.actionTimeoutMilliseconds || 10000)) });
    if (handle) {
      await expect.poll(() => handle.evaluate((element) => !element.isConnected || element.disabled)
        .catch(() => true), { timeout: Math.max(1000, Number(loadConfig.actionTimeoutMilliseconds || 10000)) }).toBe(true);
    }
  }
}

function percentile(values, percentage) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((percentage / 100) * sorted.length) - 1)];
}

test.describe.configure({ mode: 'serial' });

test('L1 single-browser load and performance workflow', async ({ page }, testInfo) => {
    const browserSession = 1;
    test.setTimeout(0);
    const username = process.env.OC_USERNAME || executionConfig.credentials?.username;
    const mobileNumber = process.env.OC_MOBILE_NUMBER || executionConfig.credentials?.mobileNumber;
    const password = process.env.OC_PASSWORD || executionConfig.credentials?.password;
    if (!username || !mobileNumber || !password) {
      throw new Error('Run run-load-test.ps1 and enter username, mobile number, and password in the terminal.');
    }

    const configuredDurationSeconds = Number(loadConfig.durationSeconds ?? 0);
    const configuredMaxEvents = Number(loadConfig.maxEvents ?? 0);
    const durationMs = configuredDurationSeconds > 0
      ? configuredDurationSeconds * 1000
      : Number.POSITIVE_INFINITY;
    const maxEvents = configuredMaxEvents > 0
      ? Math.floor(configuredMaxEvents)
      : Number.POSITIVE_INFINITY;
    const pollMs = Math.max(100, Number(loadConfig.queuePollMilliseconds || 500));
    const maxIdlePolls = Math.max(1, Number(loadConfig.maxIdlePolls || 20));
    const startWith = String(actionConfig.startWith || 'escalate').toLowerCase();
    if (!['escalate', 'terminate'].includes(startWith)) {
      throw new Error('alternateActions.startWith must be "escalate" or "terminate".');
    }

    const metrics = {
      browserSession,
      startedAt: new Date().toISOString(),
      configuredDurationSeconds: Number.isFinite(durationMs) ? durationMs / 1000 : 'until-empty',
      configuredMaxEvents: Number.isFinite(maxEvents) ? maxEvents : 'until-empty',
      attemptedEvents: 0,
      successfulEvents: 0,
      failedEvents: 0,
      childEventsProcessed: 0,
      escalatedEvents: 0,
      terminatedEvents: 0,
      eventDurationsMs: [],
      events: [],
      failures: [],
    };

    const login = new LoadLoginPage(page);
    const instructions = new LoadInstructionsPage(page);
    const queue = new LoadQueuePage(page);
    const eventIdTracker = new LoadEventIdTracker(page);
    const networkMonitor = new LoadPlaybackNetworkMonitor(page);
    const loginStartedAt = Date.now();
    await login.login(username, mobileNumber, password);
    await instructions.acceptIfShown();
    await queue.waitUntilReady();
    metrics.loginDurationMs = Date.now() - loginStartedAt;
    metrics.browserNavigation = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0];
      if (!navigation) return null;
      return {
        dnsMs: Math.max(0, Math.round(navigation.domainLookupEnd - navigation.domainLookupStart)),
        connectionMs: Math.max(0, Math.round(navigation.connectEnd - navigation.connectStart)),
        ttfbMs: Math.max(0, Math.round(navigation.responseStart - navigation.requestStart)),
        domContentLoadedMs: Math.max(0, Math.round(navigation.domContentLoadedEventEnd)),
        loadCompleteMs: Math.max(0, Math.round(navigation.loadEventEnd)),
        transferSizeBytes: navigation.transferSize || 0,
        decodedBodySizeBytes: navigation.decodedBodySize || 0,
      };
    });

    const runStartedAt = Date.now();
    let idlePolls = 0;
    let actionIndex = 0;
    let queueBecameEmpty = false;
    while (Date.now() - runStartedAt < durationMs && metrics.attemptedEvents < maxEvents) {
      if (loadConfig.stopWhenQueueEmpty !== false && await queue.queueIsEmpty()) {
        queueBecameEmpty = true;
        break;
      }
      const action = actionIndex % 2 === 0
        ? startWith
        : (startWith === 'escalate' ? 'terminate' : 'escalate');
      const selected = await queue.selectNext(action);
      if (!selected) {
        idlePolls += 1;
        if (idlePolls >= maxIdlePolls) break;
        await page.waitForTimeout(pollMs);
        continue;
      }

      idlePolls = 0;
      actionIndex += 1;
      metrics.attemptedEvents += 1;
      console.log(`[LOAD][BROWSER] Alternating action ${metrics.attemptedEvents}: ${action.toUpperCase()} selected for card ${selected.slot}; next scan starts from the following card.`);
      const eventStartedAt = Date.now();
      const networkCaptureStartedAt = Date.now();
      const eventRecord = {
        browserSession,
        eventNumber: metrics.attemptedEvents,
        action,
        slot: selected.slot,
        grouped: selected.grouped,
        startedAt: new Date(eventStartedAt).toISOString(),
        status: 'RUNNING',
      };
      try {
        eventRecord.eventId = await eventIdTracker.findForCard(queue.selectedCard);
        console.log(`[LOAD][BROWSER] Event ${metrics.attemptedEvents} passive Event ID: ${eventRecord.eventId || 'unavailable'}.`);
        await queue.startPlaybackNetworkCapture();
        if (selected.grouped) {
          await queue.openSiteGroup();
          metrics.childEventsProcessed += await queue.processChildren(action);
          await page.waitForTimeout(Math.max(0, Number(loadConfig.parentDelayMilliseconds || 0)));
        }
        await queue.processParent(action);
        metrics.successfulEvents += 1;
        metrics[`${action}dEvents`] += 1;
        eventRecord.status = 'PASSED';
        console.log(`[LOAD][BROWSER] ${action.toUpperCase()} completed for event ${metrics.attemptedEvents} in slot ${selected.slot}.`);
      } catch (error) {
        metrics.failedEvents += 1;
        eventRecord.status = 'FAILED';
        eventRecord.error = error.message;
        metrics.failures.push({
          eventNumber: metrics.attemptedEvents,
          action,
          slot: selected.slot,
          message: error.message,
        });
        console.warn(`[LOAD][BROWSER] ${action.toUpperCase()} failed for event ${metrics.attemptedEvents}: ${error.message}`);
        await page.keyboard.press('Escape').catch(() => undefined);
      } finally {
        eventRecord.playbackNetwork = await networkMonitor.reportFor(
          queue.selectedCard,
          networkCaptureStartedAt,
          Date.now(),
        );
        eventRecord.durationMs = Date.now() - eventStartedAt;
        eventRecord.finishedAt = new Date().toISOString();
        metrics.eventDurationsMs.push(eventRecord.durationMs);
        metrics.events.push(eventRecord);
      }
    }

    if (queueBecameEmpty) {
      await queue.logoutFromEmptyQueue();
    }

    metrics.finishedAt = new Date().toISOString();
    metrics.actualDurationMs = Date.now() - runStartedAt;
    metrics.failurePercent = metrics.attemptedEvents
      ? Number(((metrics.failedEvents / metrics.attemptedEvents) * 100).toFixed(2))
      : 0;
    metrics.responseTimesMs = {
      minimum: metrics.eventDurationsMs.length ? Math.min(...metrics.eventDurationsMs) : 0,
      average: metrics.eventDurationsMs.length
        ? Math.round(metrics.eventDurationsMs.reduce((sum, value) => sum + value, 0) / metrics.eventDurationsMs.length)
        : 0,
      p50: percentile(metrics.eventDurationsMs, 50),
      p95: percentile(metrics.eventDurationsMs, 95),
      p99: percentile(metrics.eventDurationsMs, 99),
      maximum: metrics.eventDurationsMs.length ? Math.max(...metrics.eventDurationsMs) : 0,
    };
    metrics.throughputEventsPerMinute = metrics.actualDurationMs
      ? Number(((metrics.successfulEvents / metrics.actualDurationMs) * 60000).toFixed(2))
      : 0;
    metrics.browserRuntime = await page.evaluate(() => ({
      resourceCount: performance.getEntriesByType('resource').length,
      usedJavaScriptHeapBytes: performance.memory?.usedJSHeapSize || null,
      totalJavaScriptHeapBytes: performance.memory?.totalJSHeapSize || null,
    })).catch(() => null);

    const summaryPath = testInfo.outputPath('load-performance-summary-single-browser.json');
    fs.writeFileSync(summaryPath, JSON.stringify(metrics, null, 2));
    const sharedSummaryPath = path.join(loadDataDirectory, `session-${loadRunId}-${process.pid}.json`);
    fs.writeFileSync(sharedSummaryPath, JSON.stringify(metrics, null, 2));
    await testInfo.attach('Single-Browser Load and Performance Summary', {
      path: summaryPath,
      contentType: 'application/json',
    });
    console.log(`[LOAD][BROWSER] completed: ${metrics.successfulEvents}/${metrics.attemptedEvents} successful, ${metrics.failurePercent}% failures, throughput=${metrics.throughputEventsPerMinute}/min, p95=${metrics.responseTimesMs.p95}ms.`);

    const failureThreshold = Math.max(0, Number(loadConfig.failureThresholdPercent ?? 10));
    expect(metrics.failurePercent, 'Single-browser workflow exceeded the configured failure threshold').toBeLessThanOrEqual(failureThreshold);
  });
