// @ts-nocheck
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// Page object for authentication. Credentials come from environment variables or execution.config.json or the command prompt; they are never stored in the test.
class LoginPage {
  constructor(page) {
    this.page = page;
    this.username = page.locator("//input[@placeholder='Enter your email or username']");
    const configuredMobileNumber = page.locator("//input[@id='*r_4h3*']");
    const mobileNumberFallback = page.locator([
      "//input[contains(@id,'r_4h3')]",
      "//input[@type='tel']",
      "//input[contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'mobile')]",
    ].join(' | '));
    this.mobileNumber = configuredMobileNumber.or(mobileNumberFallback).first();
    this.password = page.locator("//input[@placeholder='Enter your password']");
    this.loginButton = page.locator("//button[@class='submit-button']");
    this.passwordToggle = page.getByRole('button', { name: 'toggle password visibility' });
    this.forgotPassword = page.getByText('Forgot password?', { exact: true });
  }
  async open() { await this.page.goto('/'); }
  async expectVisible() {
    await expect(this.username).toBeVisible();
    await expect(this.mobileNumber, 'Mandatory Mobile Number field was not visible').toBeVisible();
  }
  async login(username, mobileNumber, password) {
    await this.username.fill(username);
    await this.mobileNumber.fill(mobileNumber);
    await this.password.fill(password);
    await this.loginButton.click();
  }
  async openRecovery() { await this.forgotPassword.click(); }
}

class InstructionsPage {
  constructor(page) {
    this.page = page;
    this.acceptCheckbox = page.getByRole('checkbox', { name: 'I have read and accept the instructions.' });
    this.proceedButton = page.getByRole('button', { name: 'Accept & Proceed' });
    this.backButton = page.getByRole('button', { name: 'Back', exact: true });
  }
  async expectVisible() { await expect(this.acceptCheckbox).toBeVisible(); }
  async accept() { await this.acceptCheckbox.check(); }
  async proceed() {
    await expect(this.proceedButton).toBeEnabled();
    await this.proceedButton.click();
  }
  async acceptAndProceed() { await this.accept(); await this.proceed(); }
  async acceptIfShown() {
    const shown = await this.acceptCheckbox.waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!shown) return false;
    await this.acceptAndProceed();
    return true;
  }
  async back() { await this.backButton.click(); }
}

class OperatorConsolePage {
  constructor(page) {
    this.page = page;
    this.slots = page.locator('.l1-card-slot');
    this.levelBanner = page.getByText(/^Level:L1\s*\|\s*Queue:/);
    this.noEventAvailable = page.locator("//div[@title='No Event Available']");
  }

  async expectReady() {
    await expect(this.page).toHaveURL(/\/levell1\/?(?:[?#].*)?$/);
    await expect(this.levelBanner).toBeVisible();
    await expect(this.slots).toHaveCount(8);
  }

  async isEmptyQueue() {
    const terminationButtons = [
      'Camera Disconnect',
      'Person Seen No Threat',
      'House Keeping',
      'Guard/Staff On Site',
      'False Activity',
      'ATM Transaction',
      'Guard Sleeping',
    ];
    const selector = terminationButtons.map((tag) => `button[title="${tag}"]:not([disabled])`).join(', ');
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const slotCount = await this.slots.count();
      const emptyCardCount = await this.noEventAvailable.count();
      if (slotCount === 8 && emptyCardCount === slotCount) {
        let allEmptyMarkersVisible = true;
        for (let index = 0; index < emptyCardCount; index += 1) {
          if (!(await this.noEventAvailable.nth(index).isVisible().catch(() => false))) {
            allEmptyMarkersVisible = false;
            break;
          }
        }
        if (allEmptyMarkersVisible) return true;
      }
      if (await this.slots.locator(selector).count() > 0) return false;
      await this.page.waitForTimeout(250);
    }
    return false;
  }

  async logoutFromEmptyQueue() {
    await expect(this.noEventAvailable, 'All eight No Event Available markers were not present').toHaveCount(8);
    for (let index = 0; index < 8; index += 1) {
      await expect(this.noEventAvailable.nth(index), `No Event Available marker ${index + 1} was not visible`).toBeVisible();
    }
    const toggle = this.page.locator("//input[contains(@class, 'MuiSwitch-input')]").first();
    await expect(toggle, 'ToggleSwitch was not available for empty-queue logout').toBeAttached();
    await expect(toggle, 'ToggleSwitch was disabled for empty-queue logout').toBeEnabled();
    await toggle.click();
    console.log('[L1] All cards show No Event Available. ToggleSwitch clicked.');

    const logout = this.page.locator("//button[@aria-label='Logout']");
    await expect(logout, 'Logout button was not available for empty-queue logout').toBeVisible();
    await expect(logout).toBeEnabled();
    await logout.click();
    await expect(this.page.locator("//span[text()='Confirm Logout']")).toBeVisible();

    const yes = this.page.locator("//button[text()='Yes']");
    await expect(yes, 'Confirm Logout Yes button was not available').toBeVisible();
    await yes.click();
    await expect(this.page).toHaveURL(/\/?(?:[?#].*)?$/, { timeout: 10000 });
  }

}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TERMINATION_TAGS = [
  'Camera Disconnect',
  'Person Seen No Threat',
  'House Keeping',
  'Guard/Staff On Site',
  'False Activity',
  'ATM Transaction',
  'Guard Sleeping',
];

const ESCALATION_TAGS = [
  'ATM Machine Opened',
  'Back Door Opened',
  'Cash Replenishment',
  'Group of Persons',
  'Suspicious Activity',
];

const DEFAULT_ESCALATION_RULES = {
  Sensor_Event: ['Fire Smoke Sensor', 'Panic Switch', 'ATM1 Vibration'],
  Camera_Event: ['Video Loss'],
  Video_Analytic: ['helmet'],
};

const normalizeRuleValue = (value) => String(value || '').trim().toLowerCase();

function resolveRuleBasedAction(metadata, configuredRules = DEFAULT_ESCALATION_RULES) {
  const eventTag = normalizeRuleValue(metadata?.eventTag);
  const configuredTags = Object.values(configuredRules || {}).flat();
  const shouldEscalate = configuredTags.some(
    (tag) => normalizeRuleValue(tag) === eventTag,
  );
  return shouldEscalate ? 'escalate' : 'terminate';
}

class EventMetadataTracker {
  constructor(page) {
    this.records = [];
    page.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => this.recordFrame(payload));
    });
  }

  recordFrame(payload) {
    try {
      const message = JSON.parse(String(payload));
      if (message.type !== 'event' || !message.data) return;
      const data = message.data;
      const eventTimeParts = String(data.eventTime || '').split('-');
      const eventClock = eventTimeParts.length >= 3
        ? eventTimeParts.slice(-3).join(':')
        : '';
      this.records.push({
        eventType: data.currentEventType || data.sourceEventType || data.extras?.eventType || null,
        eventTag: data.currentEventTag || data.sourceEventTag || data.extras?.eventTag || null,
        siteName: String(data.siteName || data.extras?.siteName || '').trim(),
        eventClock,
      });
      if (this.records.length > 500) this.records.shift();
    } catch {
      // Ignore non-JSON frames such as video/audio transport data.
    }
  }

  async findForScope(scope) {
    const visibleText = await scope.innerText().catch(() => '');
    if (!visibleText) return null;
    const normalizeText = (value) => String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const normalizedVisibleText = normalizeText(visibleText);
    const visibleClock = visibleText.match(/Event\s+(\d{2}:\d{2}:\d{2})/i)?.[1] || '';
    const clockMatches = [];
    const siteMatches = [];
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      const siteMatchesScope = record.siteName
        && normalizedVisibleText.includes(normalizeText(record.siteName));
      const clockMatchesScope = record.eventClock
        && (visibleClock === record.eventClock || visibleText.includes(record.eventClock));
      if (siteMatchesScope && (!record.eventClock || clockMatchesScope)) {
        return { eventType: record.eventType, eventTag: record.eventTag };
      }
      if (clockMatchesScope) clockMatches.push(record);
      if (siteMatchesScope) siteMatches.push(record);
    }
    // A clock or site-only fallback is safe only when it identifies one record.
    if (clockMatches.length === 1) {
      return { eventType: clockMatches[0].eventType, eventTag: clockMatches[0].eventTag };
    }
    if (siteMatches.length === 1) {
      return { eventType: siteMatches[0].eventType, eventTag: siteMatches[0].eventTag };
    }
    return null;
  }
}

const ICON_PATHS = {
  live: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5M12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5m0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3',
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6zm8-14v14h4V5z',
  replay: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8',
};

const TOGGLE_SWITCH_XPATH = "//input[contains(@class, 'MuiSwitch-input')]";

class HealingManager {
  constructor(page, options = {}) {
    this.page = page;
    this.enabled = options.enabled !== false;
    this.maxAttempts = Number(options.maxAttempts || 2);
  }

  classify(error) {
    const message = String(error?.message || error || 'Unknown error');
    if (/(?:page|context|browser).*(?:closed|ended)|Target page.*closed/i.test(message)) return 'PAGE_CLOSED';
    if (/Timeout|timed out|timeout/i.test(message)) return 'TIMEOUT';
    if (/element\(s\) not found|not available|not visible|waiting for locator/i.test(message)) return 'ELEMENT_NOT_FOUND';
    if (/detached|not attached|not connected|stale/i.test(message)) return 'ELEMENT_DETACHED';
    if (/intercept|overlay|another element|outside of the viewport/i.test(message)) return 'OVERLAY_BLOCKING';
    if (/popup|waitForEvent\(['"]page|live-stream/i.test(message)) return 'POPUP_MISSING';
    if (/net::|ERR_|response|HTTP|network|fetch/i.test(message)) return 'NETWORK';
    return 'UNKNOWN';
  }

  suggestedRecovery(category) {
    return {
      TIMEOUT: 'Re-check loading state and use a bounded action-specific retry.',
      ELEMENT_NOT_FOUND: 'Inspect the accessibility snapshot and add a role, label, title, or text fallback.',
      ELEMENT_DETACHED: 'Recreate the locator from the current card before retrying.',
      OVERLAY_BLOCKING: 'Close the unexpected overlay safely, then retry the non-destructive action.',
      POPUP_MISSING: 'Register popup and response listeners again before one bounded retry.',
      NETWORK: 'Check the failed response and retry only the non-destructive request.',
      PAGE_CLOSED: 'Stop execution and start a new controlled run.',
      UNKNOWN: 'Use the trace, screenshot, DOM text, and MCP accessibility snapshot for analysis.',
    }[category];
  }

  safeUrl() {
    try {
      const current = new URL(this.page.url());
      current.username = '';
      current.password = '';
      current.search = '';
      current.hash = '';
      return current.toString();
    } catch {
      return 'unavailable';
    }
  }

  async capture(step, error, attempt, finalFailure = false) {
    const category = this.classify(error);
    const timestamp = Date.now();
    const screenshotPath = test.info().outputPath(`healing-${category.toLowerCase()}-${timestamp}.png`);
    const requestPath = test.info().outputPath(`healing-request-${timestamp}.json`);
    let screenshotSaved = false;
    let bodyText = '';

    if (!/PAGE_CLOSED/.test(category)) {
      screenshotSaved = await this.page.screenshot({ path: screenshotPath, fullPage: true })
        .then(() => true)
        .catch(() => false);
      bodyText = await this.page.locator('body').innerText({ timeout: 3000 })
        .then((text) => text.slice(0, 20000))
        .catch(() => '');
    }

    const request = {
      version: 1,
      timestamp: new Date(timestamp).toISOString(),
      step,
      attempt,
      finalFailure,
      category,
      message: String(error?.message || error || 'Unknown error').slice(0, 12000),
      url: this.safeUrl(),
      suggestedRecovery: this.suggestedRecovery(category),
      mcp: {
        recommendedServer: '@playwright/mcp',
        purpose: 'Inspect the current accessibility tree and propose a local, reviewable repair.',
      },
      artifacts: {
        screenshot: screenshotSaved ? path.basename(screenshotPath) : null,
        trace: 'trace.zip',
      },
      visiblePageText: bodyText,
    };
    fs.writeFileSync(requestPath, JSON.stringify(request, null, 2));
    await test.info().attach(`Healing request - ${category} - ${step}`, {
      path: requestPath,
      contentType: 'application/json',
    });
    if (screenshotSaved) {
      await test.info().attach(`Healing screenshot - ${category} - ${step}`, {
        path: screenshotPath,
        contentType: 'image/png',
      });
    }
    console.warn(`[L1][HEAL] ${category} during ${step}; evidence captured for attempt ${attempt}.`);
    return category;
  }

  async recover(category, step) {
    if (category === 'PAGE_CLOSED') return false;
    if (category === 'POPUP_MISSING' || category === 'NETWORK') {
      const extraPages = this.page.context().pages().filter((candidate) => candidate !== this.page);
      await Promise.all(extraPages.map((candidate) => candidate.close().catch(() => undefined)));
    }
    if (category === 'OVERLAY_BLOCKING' || category === 'ELEMENT_NOT_FOUND') {
      const overlay = this.page.locator('[role="dialog"]:visible, [role="menu"]:visible').last();
      if (await overlay.isVisible().catch(() => false)) {
        const safeClose = overlay.getByRole('button', {
          name: /^(close|cancel|dismiss|not now|no thanks)$/i,
        }).first();
        if (await safeClose.isVisible().catch(() => false)) await safeClose.click();
        else await this.page.keyboard.press('Escape');
      }
    }
    await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    await this.page.waitForTimeout(500);
    console.log(`[L1][HEAL] Recovery applied for ${category} before retrying ${step}.`);
    return true;
  }

  async run(step, operation, options = {}) {
    if (!this.enabled) return operation();
    const attempts = options.maxAttempts || this.maxAttempts;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await operation(attempt);
      } catch (error) {
        const finalFailure = attempt >= attempts;
        const category = await this.capture(step, error, attempt, finalFailure);
        if (finalFailure || options.safeToRetry === false || !(await this.recover(category, step))) {
          throw error;
        }
      }
    }
    throw new Error(`Healing attempts exhausted for ${step}.`);
  }
}

// Handles both standalone cards and Site Group drawers. The configured action
// mode is passed into this object so the same workflow can terminate or escalate.
class SiteGroupingPage {
  constructor(page, resilience = {}, reporting = {}, metadataTracker = null) {
    this.page = page;
    this.resilience = {
      autoHealElements: resilience.autoHealElements !== false,
      autoAddNewEvents: resilience.autoAddNewEvents !== false,
      recoverUserInterference: resilience.recoverUserInterference !== false,
    };
    this.reporting = {
      attachSiteInfoScreenshots: reporting.siteInfoScreenshots !== false,
      attachLiveViewScreenshots: reporting.liveViewScreenshots !== false,
      attachFullRunVideo: reporting.fullRunVideo !== false,
    };
    this.healer = new HealingManager(page, {
      enabled: this.resilience.autoHealElements,
      maxAttempts: 2,
    });
    this.metadataTracker = metadataTracker;
    this.parentCard = null;
    this.badge = null;
    this.drawer = null;
    this.childCount = 0;
    this.lastEventMetadata = null;
  }

  actionButton(scope, tag) {
    const primary = scope.locator(`button[title="${tag}"]:not([disabled])`);
    if (!this.resilience.autoHealElements) return primary.first();
    const ariaFallback = scope.locator(`button[aria-label="${tag}"]:not([disabled])`);
    const textFallback = scope.locator('button:not([disabled])').filter({
      hasText: new RegExp(`^\\s*${escapeRegExp(tag)}\\s*$`, 'i'),
    });
    return primary.or(ariaFallback).or(textFallback).first();
  }

  infoControl(scope, ariaLabel) {
    const primary = scope.locator(`span[aria-label="${ariaLabel}"]`);
    if (!this.resilience.autoHealElements) return primary.first();
    const buttonFallback = scope.locator(`button[aria-label="${ariaLabel}"]`);
    const titledFallback = scope.locator(`button[title="${ariaLabel}"]`);
    return primary.or(buttonFallback).or(titledFallback).first();
  }

  async recoverFromUserInterference(label = 'queue scan') {
    if (!this.resilience.recoverUserInterference) return;
    const overlay = this.page.locator('[role="dialog"]:visible, [role="menu"]:visible').last();
    if (!(await overlay.isVisible().catch(() => false))) return;

    const screenshotPath = test.info().outputPath(`auto-recovery-${Date.now()}.png`);
    await this.page.screenshot({ path: screenshotPath, fullPage: true });
    await test.info().attach(`Auto recovery - ${label}`, {
      path: screenshotPath,
      contentType: 'image/png',
    });

    const safeClose = overlay.getByRole('button', {
      name: /^(close|cancel|dismiss|not now|no thanks)$/i,
    }).first();
    if (await safeClose.isVisible().catch(() => false)) {
      await safeClose.click();
    } else {
      await this.page.keyboard.press('Escape');
    }
    console.log(`[L1] Auto recovery handled user-opened UI before ${label}.`);
  }

  async detectSiteGroup(timeout = 5000) {
    const badges = this.page.getByRole('button', { name: /^\d+ same-site events?$/ });
    await badges.first().waitFor({ state: 'visible', timeout }).catch(() => undefined);
    for (let index = 0; index < await badges.count(); index += 1) {
      const badge = badges.nth(index);
      const label = await badge.getAttribute('aria-label');
      const match = label?.match(/^(\d+) same-site events?$/);
      if (!match) continue;
      const childCount = Number(match[1]);
      if (childCount === 0) continue;
      this.badge = badge;
      this.childCount = childCount;
      this.parentCard = badge.locator('xpath=ancestor::*[contains(@class,"l1-card-slot")]');
      await expect(this.parentCard).toBeVisible();
      console.log(`[L1] Found Site Group badge with ${this.childCount} child event(s).`);
      return true;
    }
    this.badge = null;
    return false;
  }

  countLabel(count) {
    return `${count} same-site event${count === 1 ? '' : 's'}`;
  }

  validateActionTag(tag, actionMode = 'terminate') {
    if (!['terminate', 'escalate'].includes(actionMode)) {
      throw new Error(`Unsupported event action "${actionMode}". Use "terminate" or "escalate".`);
    }
    if (!tag || typeof tag !== 'string') {
      throw new Error(`A button title is required for the "${actionMode}" action.`);
    }
  }

  actionToast(tag) {
    return this.page.getByText(
      new RegExp(`Event (?:Acknowledged|terminated|escalated):\\s*${escapeRegExp(tag)}`, 'i'),
    ).last();
  }

  async selectDirectEvent(tag = 'False Activity', actionMode = 'terminate') {
    this.validateActionTag(tag, actionMode);
    const action = this.actionButton(this.page.locator('.l1-card-slot'), tag);
    await expect(action, `No direct event was available for the "${tag}" termination`).toBeVisible({ timeout: 45000 });
    this.parentCard = action.locator('xpath=ancestor::*[contains(@class,"l1-card-slot")]').first();
    await expect(this.parentCard).toBeVisible();
    console.log(`[L1] No Site Group badge found. Selected a direct event for "${tag}".`);
  }

  async selectQueueCard(slot, directTag = 'False Activity', actionMode = 'terminate') {
    this.validateActionTag(directTag, actionMode);
    const badge = slot.getByRole('button', { name: /^\d+ same-site events?$/ }).first();
    if (await badge.isVisible().catch(() => false)) {
      const label = await badge.getAttribute('aria-label');
      const match = label?.match(/^(\d+) same-site events?$/);
      if (match && Number(match[1]) > 0) {
        this.badge = badge;
        this.childCount = Number(match[1]);
        this.parentCard = slot;
        console.log(`[L1] Selected queue card with ${this.childCount} child event(s).`);
        return true;
      }
    }

    const directAction = this.actionButton(slot, directTag);
    if (!(await directAction.isVisible().catch(() => false))) return null;
    this.badge = null;
    this.childCount = 0;
    this.parentCard = slot;
    console.log(`[L1] Selected standalone queue event for "${directTag}".`);
    return false;
  }

  async expectTerminationChoices() {
    await this.expectEventControls(this.parentCard, 'parent event');
  }

  async expectEventControls(card, label = 'event') {
    const terminationChecks = await Promise.all(TERMINATION_TAGS.map(async (tag) => ({
      tag,
      visible: await card.locator(`button[title="${tag}"]`).first().isVisible().catch(() => false),
    })));
    const escalationChecks = await Promise.all(ESCALATION_TAGS.map(async (tag) => ({
      tag,
      visible: await card.locator(`button[title="${tag}"]`).first().isVisible().catch(() => false),
    })));
    const missingTermination = terminationChecks.filter(({ visible }) => !visible).map(({ tag }) => tag);
    const missingEscalation = escalationChecks.filter(({ visible }) => !visible).map(({ tag }) => tag);
    const snapshot = card.locator('span[aria-label^="Mask Area:"] button').first();
    await expect(snapshot, `Snapshot/image control was not available on ${label}`).toBeVisible();
    if (missingTermination.length || missingEscalation.length) {
      const details = [
        missingTermination.length ? `grey: ${missingTermination.join(', ')}` : '',
        missingEscalation.length ? `pink: ${missingEscalation.join(', ')}` : '',
      ].filter(Boolean).join('; ');
      throw new Error(`Missing L1 choices on ${label}: ${details}`);
    }
  }

  eventCardFromAction(action, tag) {
    return action.locator(
      `xpath=ancestor::*[.//button[@title="${tag}"] and .//button[@title="Guard Sleeping"] and .//*[contains(normalize-space(.),"Event ")]][1]`,
    );
  }

  async checkEvent(card, label = 'event', checkLiveView = false) {
    const originalCard = this.parentCard;
    this.parentCard = card;
    const failures = [];
    this.lastEventMetadata = null;
    try {
      try {
        this.lastEventMetadata = await this.healer.run(
          `Play and Replay - ${label}`,
          () => this.checkPlayAndReplay(label),
        );
      } catch (error) {
        failures.push(`Play/Replay: ${error.message}`);
      }
      if (checkLiveView) {
        try {
          await this.healer.run(`Live View - ${label}`, () => this.verifyLiveView(label));
        } catch (error) {
          failures.push(`Live View: ${error.message}`);
        }
      }
      try {
        await this.expectEventControls(card, label);
      } catch (error) {
        failures.push(`Controls: ${error.message}`);
      }
    } finally {
      this.parentCard = originalCard;
    }
    if (failures.length) throw new Error(failures.join('\n'));
    return this.lastEventMetadata;
  }

  async expectToggleSwitch(label = 'L1 queue') {
    const toggleSwitch = this.page.locator(TOGGLE_SWITCH_XPATH).first();
    await expect(toggleSwitch, `Toggle switch was not available on ${label}`).toBeAttached();
    await expect(toggleSwitch, `Toggle switch was disabled on ${label}`).toBeEnabled();
  }

  async checkChildEvent(card, label = 'child event') {
    const originalCard = this.parentCard;
    this.parentCard = card;
    const failures = [];
    try {
      try {
        await this.healer.run(`Play and Replay - ${label}`, () => this.checkPlayAndReplay(label));
      } catch (error) {
        failures.push(`Play/Replay: ${error.message}`);
      }
      try {
        await this.expectEventControls(card, label);
      } catch (error) {
        failures.push(`Controls: ${error.message}`);
      }
    } finally {
      this.parentCard = originalCard;
    }
    if (failures.length) throw new Error(failures.join('\n'));
  }

  async checkPlayAndReplay(label = 'selected event') {
    let metadata = null;
    await this.clickInfoControl('Event Info', label, false, async () => {
      metadata = await this.readEventMetadata(this.parentCard, label);
    });

    const playIcon = this.parentCard.locator(`button:has(svg path[d="${ICON_PATHS.play}"])`);
    const pauseIcon = this.parentCard.locator(`button:has(svg path[d="${ICON_PATHS.pause}"])`);
    const play = this.resilience.autoHealElements
      ? playIcon.or(this.parentCard.locator('span[aria-label="Play"] button, button[title="Play"]')).first()
      : playIcon.first();
    const pause = this.resilience.autoHealElements
      ? pauseIcon.or(this.parentCard.locator('span[aria-label="Pause"] button, button[title="Pause"]')).first()
      : pauseIcon.first();
    await expect(play.or(pause), `Play/Pause control was not available on ${label}`).toBeVisible({ timeout: 30000 });
    if (await pause.isVisible()) {
      await pause.click();
    }
    await expect(play).toBeVisible({ timeout: 15000 });
    await expect(play).toBeEnabled({ timeout: 30000 });
    await play.click();
    await expect(pause).toBeVisible({ timeout: 15000 });
    console.log(`[L1] Play clicked and Pause state confirmed for ${label}.`);

    const replayIcon = this.parentCard.locator(`button:has(svg path[d="${ICON_PATHS.replay}"])`);
    const replay = this.resilience.autoHealElements
      ? replayIcon.or(this.parentCard.locator('span[aria-label="Replay"] button, button[title="Replay"]')).first()
      : replayIcon.first();
    await expect(replay, `Replay control was not available on ${label}`).toBeVisible();
    await expect(replay).toBeEnabled();
    await replay.click();
    await expect(replay).toBeEnabled();
    console.log(`[L1] Replay clicked for ${label}.`);
    return metadata;
  }

  async findVisibleExactText(scope, values) {
    for (const value of values) {
      const match = scope.getByText(value, { exact: true });
      for (let index = 0; index < await match.count(); index += 1) {
        if (await match.nth(index).isVisible().catch(() => false)) return value;
      }
    }
    return null;
  }

  async readLabeledValue(scope, fieldName) {
    const scopedLabel = scope.locator(`xpath=.//div[normalize-space(text())="${fieldName}"]`).last();
    let label = scopedLabel;
    if (!(await scopedLabel.isVisible().catch(() => false))) {
      const portalLabel = this.page.locator(`//div[normalize-space(text())="${fieldName}"]`).last();
      const appeared = await portalLabel.waitFor({ state: 'visible', timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      if (!appeared) return null;
      label = portalLabel;
    }
    const rowText = (await label.locator('xpath=..').innerText()).trim();
    const value = rowText
      .replace(new RegExp(`^\\s*${escapeRegExp(fieldName)}\\s*:?\\s*`, 'i'), '')
      .trim();
    return value || null;
  }

  async readEventMetadata(scope, label = 'event') {
    const configuredTypes = Object.keys(this.ruleBasedRules || DEFAULT_ESCALATION_RULES);
    const configuredTags = Object.values(this.ruleBasedRules || DEFAULT_ESCALATION_RULES).flat();
    const visibleDialog = this.page.locator('[role="dialog"]:visible').last();
    const metadataScope = await visibleDialog.isVisible().catch(() => false) ? visibleDialog : scope;
    let eventType = await this.readLabeledValue(metadataScope, 'Event Type');
    let eventTag = await this.readLabeledValue(metadataScope, 'Event Tag');
    eventType ||= await this.findVisibleExactText(metadataScope, configuredTypes);
    eventTag ||= await this.findVisibleExactText(metadataScope, configuredTags);
    if ((!eventType || !eventTag) && metadataScope !== scope) {
      eventType ||= await this.findVisibleExactText(scope, configuredTypes);
      eventTag ||= await this.findVisibleExactText(scope, configuredTags);
    }
    // Event Info is rendered in a MUI portal outside the card without a dialog
    // role. Only the clicked card's portal is visible, so use the page as the
    // final scope after preferring the card/drawer itself.
    eventType ||= await this.findVisibleExactText(this.page, configuredTypes);
    eventTag ||= await this.findVisibleExactText(this.page, configuredTags);
    if ((!eventType || !eventTag) && this.metadataTracker) {
      const tracked = await this.metadataTracker.findForScope(scope);
      eventType ||= tracked?.eventType || null;
      eventTag ||= tracked?.eventTag || null;
    }
    const metadata = { eventType, eventTag };
    console.log(`[L1] ${label} metadata: Event Type="${eventType || 'unrecognized/missing'}", Event Tag="${eventTag || 'unrecognized/missing'}".`);
    return metadata;
  }

  configureRuleBasedDecision(rules) {
    this.ruleBasedRules = rules && Object.keys(rules).length ? rules : DEFAULT_ESCALATION_RULES;
  }

  async clickInfoControl(ariaLabel, label, captureScreenshot = false, afterFirstClick = null) {
    const control = this.infoControl(this.parentCard, ariaLabel);
    await expect(control, `${ariaLabel} control was not available on ${label}`).toBeVisible({ timeout: 15000 });
    const pagesBeforeClick = new Set(this.page.context().pages());
    await control.click();
    console.log(`[L1] ${ariaLabel} clicked for ${label}.`);
    if (ariaLabel === 'Event Info') {
      await this.page.waitForTimeout(300);
      if (afterFirstClick) await afterFirstClick();
      await control.click();
      console.log(`[L1] Event Info clicked a second time for ${label}.`);
    }
    await this.page.waitForTimeout(500);

    const openedPage = this.page.context().pages().find((candidate) => !pagesBeforeClick.has(candidate));
    const screenshot = captureScreenshot
      ? await (openedPage || this.page).screenshot({ fullPage: true })
      : null;

    if (openedPage) {
      await openedPage.close();
    } else {
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(200);
    }
    return screenshot;
  }

  async open() {
    await this.badge.click();
    console.log('[L1] Numbered Site Group badge clicked.');
    const heading = this.page.getByRole('heading', { name: /^Site Grouping/ });
    await expect(heading).toBeVisible();
    this.drawer = this.page.locator('.MuiDrawer-paper').filter({ has: heading });
    await expect(this.drawer).toBeVisible();
    const currentCount = this.drawer.getByText(/^\d+ same-site events?$/).first();
    await expect(currentCount).toBeVisible({ timeout: 30000 });
    const currentLabel = (await currentCount.textContent())?.trim() || '';
    const match = currentLabel.match(/^(\d+) same-site events?$/);
    if (!match) throw new Error(`Could not read the live Site Group count from "${currentLabel}".`);
    this.childCount = Number(match[1]);
    console.log(`[L1] Site Group currently contains ${this.childCount} child event(s).`);
    await expect(this.drawer.getByText('Waiting for same-site event', { exact: true })).toHaveCount(6 - this.childCount);
    await expect(this.drawer.getByRole('button', { name: 'Live view', exact: true })).toBeVisible();
  }

  async readDrawerChildCount() {
    const countLabel = this.drawer.getByText(/^\d+ same-site events?$/).first();
    await expect(countLabel, 'Site Group child count was not visible').toBeVisible({ timeout: 30000 });
    const text = (await countLabel.textContent())?.trim() || '';
    const match = text.match(/^(\d+) same-site events?$/);
    if (!match) throw new Error(`Could not read the Site Group child count from "${text}".`);
    return Number(match[1]);
  }

  async originalActionCompleted(handle) {
    return handle.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return !element.isConnected
        || element.disabled
        || style.display === 'none'
        || style.visibility === 'hidden';
    }).catch(() => true);
  }

  async completeChildEscalation(escalationConfig = {}) {
    const notes = escalationConfig.childNotes || 'Escalated by the automated L1 workflow.';
    const notesXPath = "//textarea[contains(@id,'r_12l')]";
    const confirmXPath = "//button[text()='Escalate']";

    const configuredNotesBox = this.page.locator(notesXPath);
    const notesFallback = this.page.locator([
      'textarea[id*="r_12l"]',
      'textarea[placeholder*="note" i]',
      '[role="dialog"] textarea',
    ].join(', '));
    const notesBox = this.resilience.autoHealElements
      ? configuredNotesBox.or(notesFallback).last()
      : configuredNotesBox.last();
    await expect(notesBox, 'Child escalation notes textarea was not visible').toBeVisible({ timeout: 15000 });
    await notesBox.fill(notes);
    console.log('[L1] Child escalation notes entered.');

    const configuredConfirm = this.page.locator(confirmXPath);
    const confirmFallback = this.page.getByRole('button', { name: 'Escalate', exact: true });
    const confirm = this.resilience.autoHealElements
      ? configuredConfirm.or(confirmFallback).last()
      : configuredConfirm.last();
    await expect(confirm, 'Child escalation confirmation button was not visible').toBeVisible({ timeout: 15000 });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    console.log('[L1] Child escalation confirmed with the Escalate button.');
  }

  async processChildAction(tag, actionMode = 'terminate', escalationConfig = {}) {
    this.validateActionTag(tag, actionMode);
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const beforeCount = await this.readDrawerChildCount();
      if (beforeCount === 0) return 0;
      try {
        const existingToast = this.actionToast(tag);
        if (await existingToast.isVisible().catch(() => false)) {
          await existingToast.waitFor({ state: 'hidden', timeout: 10000 });
        }
        const button = this.actionButton(this.drawer, tag);
        await expect(button, `No child event was available for the "${tag}" termination`).toBeVisible({ timeout: 30000 });
        const originalButton = await button.elementHandle();
        if (!originalButton) throw new Error(`Could not anchor the child "${tag}" action before clicking it.`);
        await button.click();
        if (actionMode === 'escalate') {
          await this.completeChildEscalation(escalationConfig);
        }
        const toast = this.actionToast(tag);
        await expect(toast).toBeVisible({ timeout: 20000 });
        await expect.poll(() => this.readDrawerChildCount(), {
          message: `Site Group count did not decrease after child "${tag}" ${actionMode}`,
          timeout: 20000,
        }).toBeLessThan(beforeCount);
        await expect.poll(() => this.originalActionCompleted(originalButton), {
          message: `The clicked child "${tag}" action remained active after ${actionMode}`,
          timeout: 10000,
        }).toBe(true);
        const afterCount = await this.readDrawerChildCount();
        console.log(`[L1] Child event ${actionMode === 'terminate' ? 'terminated' : 'escalated'} with "${tag}" on attempt ${attempt}. Drawer count: ${beforeCount} -> ${afterCount}.`);
        return afterCount;
      } catch (error) {
        lastError = error;
        const afterFailureCount = await this.readDrawerChildCount().catch(() => beforeCount);
        if (afterFailureCount < beforeCount) {
          throw new Error(`Child ${actionMode} changed the drawer count from ${beforeCount} to ${afterFailureCount}, but confirmation failed. Refusing to retry and risk acting on another child: ${error.message}`);
        }
        if (attempt < 3) {
          console.warn(`[L1] Child ${actionMode} attempt ${attempt} failed; retrying: ${error.message}`);
          await this.page.waitForTimeout(1000);
        }
      }
    }
    await this.healer.capture(`Child event ${actionMode}`, lastError, 3, true);
    throw new Error(`Child event ${actionMode} failed after 3 attempts: ${lastError.message}`);
  }

  async drainChildren(tag = 'Camera Disconnect', actionMode = 'terminate', escalationConfig = {}) {
    this.validateActionTag(tag, actionMode);
    let processed = 0;
    let remaining = await this.readDrawerChildCount();
    while (remaining > 0) {
      processed += 1;
      if (processed > 50) throw new Error('Site Group did not drain after 50 child terminations.');
      const childAction = this.actionButton(this.drawer, tag);
      await expect(childAction, `No child event was available for the "${tag}" termination`).toBeVisible({ timeout: 30000 });
      // Drawer child cards do not expose the parent media controls, so act on
      // their configured grey/pink button directly and verify the live count.
      console.log(`[L1] Child event ${processed} is ready. ${actionMode === 'terminate' ? 'Terminating' : 'Escalating'} it directly with "${tag}".`);
      remaining = await this.processChildAction(tag, actionMode, escalationConfig);
      this.childCount = remaining;
      console.log(`[L1] Confirmed child ${actionMode}. ${remaining} child event(s) remain in the drawer.`);
    }
    console.log(`[L1] All child events have been ${actionMode === 'terminate' ? 'terminated' : 'escalated'}; the parent event remains.`);
  }

  async drainChildrenByRules(actionConfigs, rules) {
    let processed = 0;
    let remaining = await this.readDrawerChildCount();
    while (remaining > 0) {
      processed += 1;
      if (processed > 50) throw new Error('Site Group did not drain after 50 child actions.');

      const discoveryTag = actionConfigs.terminate.siteGroupChildButton;
      const discoveryAction = this.actionButton(this.drawer, discoveryTag);
      await expect(discoveryAction, `Could not identify child event ${processed}`).toBeVisible({ timeout: 30000 });
      const childCard = this.eventCardFromAction(discoveryAction, discoveryTag);
      const metadata = await this.readEventMetadata(childCard, `child event ${processed}`);
      const actionMode = resolveRuleBasedAction(metadata, rules);
      const selectedConfig = actionConfigs[actionMode];
      const actionTag = selectedConfig.siteGroupChildButton;
      console.log(`[L1] Rule decision for child event ${processed}: ${actionMode.toUpperCase()} using "${actionTag}".`);
      remaining = await this.processChildAction(actionTag, actionMode, selectedConfig);
      this.childCount = remaining;
      console.log(`[L1] Confirmed child ${actionMode}. ${remaining} child event(s) remain in the drawer.`);
    }
    console.log('[L1] All child events were processed by Event Type/Event Tag rules; the parent event remains.');
  }

  async waitBeforeParentAction(actionMode = 'terminate') {
    console.log(`[L1] Waiting 5 seconds for child-event updates before parent ${actionMode}.`);
    await this.page.waitForTimeout(5000);
  }

  async close() {
    await this.drawer.getByRole('button', { name: 'close', exact: true }).click();
    await expect(this.drawer).toBeHidden();
  }

  async processDirectAction(tag = 'False Activity', actionMode = 'terminate') {
    this.validateActionTag(tag, actionMode);
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const existingToast = this.actionToast(tag);
        if (await existingToast.isVisible().catch(() => false)) {
          await existingToast.waitFor({ state: 'hidden', timeout: 10000 });
        }
        const actionScope = this.parentCard || this.page.locator('.l1-card-slot');
        const action = this.actionButton(actionScope, tag);
        await expect(action, `No direct event was available for the "${tag}" termination`).toBeVisible({ timeout: 45000 });
        const originalAction = await action.elementHandle();
        if (!originalAction) throw new Error(`Could not anchor the parent/direct "${tag}" action before clicking it.`);
        await action.click();
        const toast = this.actionToast(tag);
        await expect(toast).toBeVisible({ timeout: 20000 });
        await expect.poll(() => this.originalActionCompleted(originalAction), {
          message: `The clicked parent/direct "${tag}" action remained active after ${actionMode}`,
          timeout: 10000,
        }).toBe(true);
        console.log(`[L1] Direct/parent event ${actionMode === 'terminate' ? 'terminated' : 'escalated'} with "${tag}" on attempt ${attempt}.`);
        return;
      } catch (error) {
        lastError = error;
        const confirmedToast = this.actionToast(tag);
        if (await confirmedToast.isVisible().catch(() => false)) {
          throw new Error(`Parent/direct ${actionMode} produced a confirmation toast, but its original action did not complete. Refusing to retry and risk acting on the next event: ${error.message}`);
        }
        if (attempt < 3) {
          console.warn(`[L1] Direct/parent ${actionMode} attempt ${attempt} failed; retrying: ${error.message}`);
          await this.page.waitForTimeout(1000);
        }
      }
    }
    await this.healer.capture(`Direct/parent event ${actionMode}`, lastError, 3, true);
    throw new Error(`Direct/parent event ${actionMode} failed after 3 attempts: ${lastError.message}`);
  }

  async verifyLiveView(label = 'selected event') {
    // Capture Site Info before opening Live View, then associate both screenshots
    // with the Unit ID returned by the live-camera request.
    const siteInfoScreenshot = await this.clickInfoControl(
      'Site Info',
      label,
      this.reporting.attachSiteInfoScreenshots,
    );
    const liveIcon = this.parentCard.locator(`button:has(svg path[d="${ICON_PATHS.live}"])`);
    const live = this.resilience.autoHealElements
      ? liveIcon.or(this.parentCard.locator('span[aria-label="Live"] button, button[title="Live"]')).first()
      : liveIcon.first();
    await expect(live).toBeVisible({ timeout: 30000 });
    const context = this.page.context();
    const popupPromise = context.waitForEvent('page', { timeout: 20000 });
    const cameraResponsePromise = context.waitForEvent('response', {
      predicate: (response) => response.url().includes('/cameras/unitId?'),
      timeout: 30000,
    });
    await live.click();
    console.log(`[L1] Live View clicked for ${label}.`);
    console.log(`[L1] Waiting 2 seconds for the Live View camera to load for ${label}.`);
    await this.page.waitForTimeout(2000);
    const [popup, cameraResponse] = await Promise.all([popupPromise, cameraResponsePromise]);
    await expect(popup).toHaveURL(/\/live-stream\?.*deviceId=.*siteName=/);
    await expect(popup.getByRole('heading', { name: /^Live Stream - / })).toBeVisible();
    const popupUrl = new URL(popup.url());
    const cameraApiUrl = new URL(cameraResponse.url());
    const unitId = popupUrl.searchParams.get('deviceId')
      || cameraApiUrl.searchParams.get('unitId')
      || 'unknown-unit';
    const safeUnitId = unitId.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (siteInfoScreenshot) {
      const siteInfoScreenshotPath = test.info().outputPath(`site-info-unit-${safeUnitId}-${Date.now()}.png`);
      fs.writeFileSync(siteInfoScreenshotPath, siteInfoScreenshot);
      await test.info().attach(`Unit ID ${unitId} - Site Info Screenshot`, {
        path: siteInfoScreenshotPath,
        contentType: 'image/png',
      });
      console.log(`[L1] Site Info screenshot attached to the report for Unit ID ${unitId}: ${path.basename(siteInfoScreenshotPath)}.`);
    }
    if (this.reporting.attachLiveViewScreenshots) {
      const screenshotPath = test.info().outputPath(`live-view-unit-${safeUnitId}-${Date.now()}.png`);
      await popup.screenshot({ path: screenshotPath, fullPage: true });
      await test.info().attach(`Unit ID ${unitId} - Live View Screenshot`, {
        path: screenshotPath,
        contentType: 'image/png',
      });
      console.log(`[L1] Live View screenshot attached to the report for Unit ID ${unitId}: ${path.basename(screenshotPath)}.`);
    }
    expect(cameraResponse.ok(), `Camera API returned HTTP ${cameraResponse.status()}`).toBeTruthy();

    const cameras = await cameraResponse.json();
    if (!Array.isArray(cameras) || cameras.length === 0) {
      throw new Error('The Live View camera API returned no cameras for the selected site.');
    }
    const firstCamera = cameras[0];
    const cameraLabel = `${firstCamera.name} - ${firstCamera.cameraId}`;
    await expect(popup.getByText(cameraLabel, { exact: true })).toBeVisible({ timeout: 30000 });
    console.log(`[L1] Live View camera confirmed for ${label}: ${cameraLabel}.`);
    await popup.close();
  }

  async verifyParentLiveView() {
    return this.verifyLiveView('parent event');
  }
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  if (testInfo.attachments.some(({ name }) => name.startsWith('Healing request -'))) return;
  const healer = new HealingManager(page, { enabled: true, maxAttempts: 1 });
  await healer.capture('Unhandled L1 workflow failure', testInfo.error, 1, true).catch(() => undefined);
});

test('L1 configured event action, playback, Live View, and Site Grouping workflow', async ({ page }) => {
  test.setTimeout(0);
  const executionConfigPath = path.resolve(__dirname, '../execution.config.json');
  if (!fs.existsSync(executionConfigPath)) {
    throw new Error(`Execution configuration was not found: ${executionConfigPath}`);
  }
  const executionConfig = JSON.parse(fs.readFileSync(executionConfigPath, 'utf8'));
  const username = process.env.OC_USERNAME || executionConfig.credentials?.username;
  const mobileNumber = process.env.OC_MOBILE_NUMBER || executionConfig.credentials?.mobileNumber;
  const password = process.env.OC_PASSWORD || executionConfig.credentials?.password;
  if (!username || !mobileNumber || !password) {
    throw new Error('Enter username, mobile number, and password in execution.config.json or run run-l1.ps1 and enter them in the terminal.');
  }

  const login = new LoginPage(page);
  const instructions = new InstructionsPage(page);
  const consolePage = new OperatorConsolePage(page);
  // The JSON mode can force one action or choose per event from Event Type/Tag.
  const resilienceConfig = executionConfig.resilience || {};
  const reportingConfig = executionConfig.reports || {};
  const metadataTracker = new EventMetadataTracker(page);
  const l1 = new SiteGroupingPage(page, resilienceConfig, reportingConfig, metadataTracker);
  const eventAction = String(executionConfig.eventAction || '').trim().toLowerCase();
  if (!['terminate', 'escalate', 'rule-based'].includes(eventAction)) {
    throw new Error('execution.config.json eventAction must be "terminate", "escalate", or "rule-based".');
  }
  const actionConfigs = {
    terminate: executionConfig.terminate || {},
    escalate: executionConfig.escalate || {},
  };
  for (const mode of ['terminate', 'escalate']) {
    l1.validateActionTag(actionConfigs[mode].parentAndStandaloneButton, mode);
    l1.validateActionTag(actionConfigs[mode].siteGroupChildButton, mode);
  }
  const ruleBasedRules = executionConfig.ruleBased?.escalateWhen || DEFAULT_ESCALATION_RULES;
  l1.configureRuleBasedDecision(ruleBasedRules);
  const selectedActionConfig = eventAction === 'rule-based' ? null : actionConfigs[eventAction];
  const directActionTag = selectedActionConfig?.parentAndStandaloneButton
    || actionConfigs.terminate.parentAndStandaloneButton;
  const siteGroupChildActionTag = selectedActionConfig?.siteGroupChildButton
    || actionConfigs.terminate.siteGroupChildButton;
  const discoveryActionMode = eventAction === 'rule-based' ? 'terminate' : eventAction;
  console.log(eventAction === 'rule-based'
    ? `[L1] Execution action: rule-based. Configured Event Tag matches escalate; all other events terminate.`
    : `[L1] Execution action: ${eventAction}. Parent/standalone button: "${directActionTag}". Site Group child button: "${siteGroupChildActionTag}".`);
  console.log(`[L1] Resilience: auto-heal=${l1.resilience.autoHealElements}, auto-add=${l1.resilience.autoAddNewEvents}, user-interference recovery=${l1.resilience.recoverUserInterference}.`);
  if (l1.resilience.recoverUserInterference) {
    page.on('dialog', (dialog) => {
      console.log(`[L1] Auto recovery dismissed browser dialog: ${dialog.type()}.`);
      dialog.dismiss().catch(() => undefined);
    });
  }
  const maxEvents = Number(process.env.L1_MAX_EVENTS || 0);
  const loginOnly = process.env.L1_LOGIN_ONLY === '1';
  const deferredFailures = [];
  let loggedOut = false;
  let reachedEventLimit = false;

  await test.step('Login and load the L1 queue', async () => {
    console.log('[L1] Opening login page.');
    await login.open();
    await login.expectVisible();
    await login.login(username, mobileNumber, password);
    console.log('[L1] Login submitted.');
    await expect(instructions.acceptCheckbox.or(consolePage.levelBanner)).toBeVisible({ timeout: 30000 });
    const accepted = await instructions.acceptIfShown();
    console.log(accepted ? '[L1] Instructions accepted.' : '[L1] Instructions were not shown; continuing to L1.');
    await consolePage.expectReady();
    await l1.expectToggleSwitch();
    console.log('[L1] L1 queue is ready. Waiting 5 seconds for events to populate.');
    await page.waitForTimeout(5000);
  });

  if (loginOnly) {
    console.log('[L1] Login-only validation passed. L1 queue loaded; event processing was skipped.');
    return;
  }

  await test.step('Process every visible L1 queue event in order', async () => {
    const queueCards = consolePage.slots;
    let processedEvents = 0;
    let attemptsWithoutEvent = 0;
    let nextCardIndex = 0;
    // Rotate through all eight cards until the exact configured empty marker is
    // visible on every card. New events can arrive while this loop is running.
    while (!(await consolePage.isEmptyQueue())) {
      await l1.recoverFromUserInterference('queue scan');
      let selected = null;
      let selectedIndex = -1;
      const queueSize = await queueCards.count();
      for (let offset = 0; offset < queueSize; offset += 1) {
        const index = (nextCardIndex + offset) % queueSize;
        const candidate = await l1.selectQueueCard(queueCards.nth(index), directActionTag, discoveryActionMode);
        if (candidate !== null) {
          selected = candidate;
          selectedIndex = index;
          nextCardIndex = (index + 1) % queueSize;
          break;
        }
      }
      if (selected === null) {
        attemptsWithoutEvent += 1;
        if (attemptsWithoutEvent > 10) throw new Error('L1 queue did not expose an actionable event before becoming empty.');
        await page.waitForTimeout(1000);
        continue;
      }
      attemptsWithoutEvent = 0;
      processedEvents += 1;
      if (l1.resilience.autoAddNewEvents) {
        console.log(`[L1] Auto-add included queue event ${processedEvents}, including events that arrived during execution.`);
      }
      let parentMetadata = null;
      try {
        parentMetadata = await l1.checkEvent(l1.parentCard, `parent event ${processedEvents}`, true);
      } catch (error) {
        parentMetadata = l1.lastEventMetadata;
        deferredFailures.push(`Parent controls ${processedEvents}: ${error.message}`);
        console.warn(`[L1] Parent control check failed for queue event ${processedEvents}; continuing with configured ${eventAction}: ${error.message}`);
      }
      const parentActionMode = eventAction === 'rule-based'
        ? resolveRuleBasedAction(parentMetadata, ruleBasedRules)
        : eventAction;
      const parentActionConfig = actionConfigs[parentActionMode];
      const parentActionTag = parentActionConfig.parentAndStandaloneButton;
      if (eventAction === 'rule-based') {
        console.log(`[L1] Rule decision for parent/direct event ${processedEvents}: ${parentActionMode.toUpperCase()} using "${parentActionTag}".`);
      }
      if (selected === true) {
        await l1.healer.run('Open Site Group drawer', () => l1.open());
        if (eventAction === 'rule-based') {
          await l1.drainChildrenByRules(actionConfigs, ruleBasedRules);
        } else {
          await l1.drainChildren(siteGroupChildActionTag, eventAction, selectedActionConfig);
        }
        await l1.healer.run('Close Site Group drawer', () => l1.close());
        await l1.waitBeforeParentAction(parentActionMode);
      }
      await l1.processDirectAction(parentActionTag, parentActionMode);
      console.log(`[L1] Queue event ${selectedIndex + 1} parent/direct ${parentActionMode} completed. Moving to the next event.`);
      if (maxEvents > 0 && processedEvents >= maxEvents) {
        reachedEventLimit = true;
        console.log(`[L1] Validation event limit ${maxEvents} reached. Ending this controlled run.`);
        break;
      }
    }
    if (!reachedEventLimit && (processedEvents === 0 || await consolePage.isEmptyQueue())) {
      // Logout is allowed only after all eight exact empty markers are visible.
      // Start saving the video before closing Chromium so the recording survives.
      await consolePage.logoutFromEmptyQueue();
      loggedOut = true;
      console.log('[L1] Logout completed. Functional execution terminated.');
      const fullRunVideo = l1.reporting.attachFullRunVideo ? page.video() : null;
      const fullRunVideoPath = test.info().outputPath(`full-automation-${Date.now()}.webm`);
      const saveFullRunVideo = fullRunVideo
        ? fullRunVideo.saveAs(fullRunVideoPath)
        : null;
      const browser = page.context().browser();
      if (browser) {
        await browser.close();
      } else {
        await page.context().close();
      }
      console.log('[L1] Browser closed after logout.');
      if (saveFullRunVideo) {
        await saveFullRunVideo;
        await test.info().attach('Full Automation Recording', {
          path: fullRunVideoPath,
          contentType: 'video/webm',
        });
        console.log(`[L1] Full automation recording attached: ${path.basename(fullRunVideoPath)}.`);
      }
    }
  });

  if (loggedOut || reachedEventLimit) return;
  if (deferredFailures.length) {
    throw new Error(`L1 media validation failed:\n- ${deferredFailures.join('\n- ')}`);
  }
});
