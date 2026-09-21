// @ts-nocheck
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// Page object for authentication. Credentials come from environment variables or
// the ignored credentials.local.json file; they are never stored in the test.
class LoginPage {
  constructor(page) {
    this.page = page;
    this.username = page.locator("//input[@placeholder='Enter your email or username']");
    this.password = page.locator("//input[@placeholder='Enter your password']");
    this.loginButton = page.locator("//button[@class='submit-button']");
    this.passwordToggle = page.getByRole('button', { name: 'toggle password visibility' });
    this.forgotPassword = page.getByText('Forgot password?', { exact: true });
  }
  async open() { await this.page.goto('/'); }
  async expectVisible() { await expect(this.username).toBeVisible(); }
  async login(username, password) {
    await this.username.fill(username);
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

const ICON_PATHS = {
  live: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5M12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5m0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3',
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6zm8-14v14h4V5z',
  replay: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8',
};

const TOGGLE_SWITCH_XPATH = "//input[contains(@class, 'MuiSwitch-input')]";

// Handles both standalone cards and Site Group drawers. The configured action
// mode is passed into this object so the same workflow can terminate or escalate.
class SiteGroupingPage {
  constructor(page) {
    this.page = page;
    this.parentCard = null;
    this.badge = null;
    this.drawer = null;
    this.childCount = 0;
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
    const action = this.page.locator(`.l1-card-slot button[title="${tag}"]:not([disabled])`).first();
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

    const directAction = slot.locator(`button[title="${directTag}"]:not([disabled])`).first();
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
    return action.locator(`xpath=ancestor::*[.//button[@title="${tag}"] and .//button[@title="Guard Sleeping"]][1]`);
  }

  async checkEvent(card, label = 'event', checkLiveView = false) {
    const originalCard = this.parentCard;
    this.parentCard = card;
    const failures = [];
    try {
      try {
        await this.checkPlayAndReplay(label);
      } catch (error) {
        failures.push(`Play/Replay: ${error.message}`);
      }
      if (checkLiveView) {
        try {
          await this.verifyLiveView(label);
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
        await this.checkPlayAndReplay(label);
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
    await this.clickInfoControl('Event Info', label);

    const play = this.parentCard.locator(`button:has(svg path[d="${ICON_PATHS.play}"])`).first();
    const pause = this.parentCard.locator(`button:has(svg path[d="${ICON_PATHS.pause}"])`).first();
    await expect(play.or(pause), `Play/Pause control was not available on ${label}`).toBeVisible({ timeout: 30000 });
    if (await pause.isVisible()) {
      await pause.click();
    }
    await expect(play).toBeVisible({ timeout: 15000 });
    await expect(play).toBeEnabled({ timeout: 30000 });
    await play.click();
    await expect(pause).toBeVisible({ timeout: 15000 });
    console.log(`[L1] Play clicked and Pause state confirmed for ${label}.`);

    const replay = this.parentCard.locator(`button:has(svg path[d="${ICON_PATHS.replay}"])`).first();
    await expect(replay, `Replay control was not available on ${label}`).toBeVisible();
    await expect(replay).toBeEnabled();
    await replay.click();
    await expect(replay).toBeEnabled();
    console.log(`[L1] Replay clicked for ${label}.`);
  }

  async clickInfoControl(ariaLabel, label, captureScreenshot = false) {
    const control = this.parentCard.locator(`span[aria-label="${ariaLabel}"]`).first();
    await expect(control, `${ariaLabel} control was not available on ${label}`).toBeVisible({ timeout: 15000 });
    const pagesBeforeClick = new Set(this.page.context().pages());
    await control.click();
    console.log(`[L1] ${ariaLabel} clicked for ${label}.`);
    if (ariaLabel === 'Event Info') {
      await this.page.waitForTimeout(300);
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

  async processChildAction(tag, actionMode = 'terminate') {
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
        const button = this.drawer.locator(`button[title="${tag}"]:not([disabled])`).first();
        await expect(button, `No child event was available for the "${tag}" termination`).toBeVisible({ timeout: 30000 });
        const originalButton = await button.elementHandle();
        if (!originalButton) throw new Error(`Could not anchor the child "${tag}" action before clicking it.`);
        await button.click();
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
    throw new Error(`Child event ${actionMode} failed after 3 attempts: ${lastError.message}`);
  }

  async drainChildren(tag = 'Camera Disconnect', actionMode = 'terminate') {
    this.validateActionTag(tag, actionMode);
    let processed = 0;
    let remaining = await this.readDrawerChildCount();
    while (remaining > 0) {
      processed += 1;
      if (processed > 50) throw new Error('Site Group did not drain after 50 child terminations.');
      const childAction = this.drawer.locator(`button[title="${tag}"]:not([disabled])`).first();
      await expect(childAction, `No child event was available for the "${tag}" termination`).toBeVisible({ timeout: 30000 });
      // Drawer child cards do not expose the parent media controls, so act on
      // their configured grey/pink button directly and verify the live count.
      console.log(`[L1] Child event ${processed} is ready. ${actionMode === 'terminate' ? 'Terminating' : 'Escalating'} it directly with "${tag}".`);
      remaining = await this.processChildAction(tag, actionMode);
      this.childCount = remaining;
      console.log(`[L1] Confirmed child ${actionMode}. ${remaining} child event(s) remain in the drawer.`);
    }
    console.log(`[L1] All child events have been ${actionMode === 'terminate' ? 'terminated' : 'escalated'}; the parent event remains.`);
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
        const action = this.parentCard
          ? this.parentCard.locator(`button[title="${tag}"]:not([disabled])`).first()
          : this.page.locator(`.l1-card-slot button[title="${tag}"]:not([disabled])`).first();
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
    throw new Error(`Direct/parent event ${actionMode} failed after 3 attempts: ${lastError.message}`);
  }

  async verifyLiveView(label = 'selected event') {
    // Capture Site Info before opening Live View, then associate both screenshots
    // with the Unit ID returned by the live-camera request.
    const siteInfoScreenshot = await this.clickInfoControl('Site Info', label, true);
    const live = this.parentCard.locator(`button:has(svg path[d="${ICON_PATHS.live}"])`).first();
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
    const siteInfoScreenshotPath = test.info().outputPath(`site-info-unit-${safeUnitId}-${Date.now()}.png`);
    fs.writeFileSync(siteInfoScreenshotPath, siteInfoScreenshot);
    await test.info().attach(`Unit ID ${unitId} - Site Info Screenshot`, {
      path: siteInfoScreenshotPath,
      contentType: 'image/png',
    });
    console.log(`[L1] Site Info screenshot attached to the report for Unit ID ${unitId}: ${path.basename(siteInfoScreenshotPath)}.`);
    const screenshotPath = test.info().outputPath(`live-view-unit-${safeUnitId}-${Date.now()}.png`);
    await popup.screenshot({ path: screenshotPath, fullPage: true });
    await test.info().attach(`Unit ID ${unitId} - Live View Screenshot`, {
      path: screenshotPath,
      contentType: 'image/png',
    });
    console.log(`[L1] Live View screenshot attached to the report for Unit ID ${unitId}: ${path.basename(screenshotPath)}.`);
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

test('L1 configured event action, playback, Live View, and Site Grouping workflow', async ({ page }) => {
  test.setTimeout(0);
  const credentialsPath = path.resolve(__dirname, '../credentials.local.json');
  const localCredentials = fs.existsSync(credentialsPath)
    ? JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
    : {};
  const username = process.env.OC_USERNAME || localCredentials.username;
  const password = process.env.OC_PASSWORD || localCredentials.password;
  if (!username || !password) {
    throw new Error('Enter the operator username and password through run-l1.ps1.');
  }

  const login = new LoginPage(page);
  const instructions = new InstructionsPage(page);
  const consolePage = new OperatorConsolePage(page);
  const l1 = new SiteGroupingPage(page);
  // One JSON switch controls the action applied to standalone events, grouped
  // children, and grouped parents for the entire execution.
  const executionConfigPath = path.resolve(__dirname, '../execution.config.json');
  if (!fs.existsSync(executionConfigPath)) {
    throw new Error(`Execution configuration was not found: ${executionConfigPath}`);
  }
  const executionConfig = JSON.parse(fs.readFileSync(executionConfigPath, 'utf8'));
  const eventAction = String(executionConfig.eventAction || '').trim().toLowerCase();
  if (!['terminate', 'escalate'].includes(eventAction)) {
    throw new Error('execution.config.json eventAction must be "terminate" or "escalate".');
  }
  const selectedActionConfig = executionConfig[eventAction] || {};
  const directActionTag = selectedActionConfig.parentAndStandaloneButton;
  const siteGroupChildActionTag = selectedActionConfig.siteGroupChildButton;
  l1.validateActionTag(directActionTag, eventAction);
  l1.validateActionTag(siteGroupChildActionTag, eventAction);
  console.log(`[L1] Execution action: ${eventAction}. Parent/standalone button: "${directActionTag}". Site Group child button: "${siteGroupChildActionTag}".`);
  const maxEvents = Number(process.env.L1_MAX_EVENTS || 0);
  const deferredFailures = [];
  let loggedOut = false;
  let reachedEventLimit = false;

  await test.step('Login and load the L1 queue', async () => {
    console.log('[L1] Opening login page.');
    await login.open();
    await login.login(username, password);
    console.log('[L1] Login submitted.');
    await expect(instructions.acceptCheckbox.or(consolePage.levelBanner)).toBeVisible({ timeout: 30000 });
    const accepted = await instructions.acceptIfShown();
    console.log(accepted ? '[L1] Instructions accepted.' : '[L1] Instructions were not shown; continuing to L1.');
    await consolePage.expectReady();
    await l1.expectToggleSwitch();
    console.log('[L1] L1 queue is ready. Waiting 5 seconds for events to populate.');
    await page.waitForTimeout(5000);
  });

  await test.step('Process every visible L1 queue event in order', async () => {
    const queueCards = consolePage.slots;
    let processedEvents = 0;
    let attemptsWithoutEvent = 0;
    let nextCardIndex = 0;
    // Rotate through all eight cards until the exact configured empty marker is
    // visible on every card. New events can arrive while this loop is running.
    while (!(await consolePage.isEmptyQueue())) {
      let selected = null;
      let selectedIndex = -1;
      const queueSize = await queueCards.count();
      for (let offset = 0; offset < queueSize; offset += 1) {
        const index = (nextCardIndex + offset) % queueSize;
        const candidate = await l1.selectQueueCard(queueCards.nth(index), directActionTag, eventAction);
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
      try {
        await l1.checkEvent(l1.parentCard, `parent event ${processedEvents}`, true);
      } catch (error) {
        deferredFailures.push(`Parent controls ${processedEvents}: ${error.message}`);
        console.warn(`[L1] Parent control check failed for queue event ${processedEvents}; continuing with configured ${eventAction}: ${error.message}`);
      }
      if (selected === true) {
        await l1.open();
        await l1.drainChildren(siteGroupChildActionTag, eventAction);
        await l1.close();
        await l1.waitBeforeParentAction(eventAction);
      }
      await l1.processDirectAction(directActionTag, eventAction);
      console.log(`[L1] Queue event ${selectedIndex + 1} parent/direct ${eventAction} completed. Moving to the next event.`);
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
      const fullRunVideo = page.video();
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
