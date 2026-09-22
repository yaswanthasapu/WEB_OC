const { defineConfig } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const executionConfigPath = path.resolve(__dirname, 'execution.config.json');
const executionConfig = fs.existsSync(executionConfigPath)
  ? JSON.parse(fs.readFileSync(executionConfigPath, 'utf8').replace(/^\uFEFF/, ''))
  : {};
const reports = executionConfig.reports || {};
const reporters = [['list']];
if (reports.html !== false) {
  reporters.push(['html', {
    open: 'never',
    outputFolder: 'playwright-report',
  }]);
}
if (reports.junit !== false) {
  reporters.push(['junit', {
    outputFile: 'reports/junit.xml',
  }]);
}
const baseURL = process.env.BASE_URL
  || executionConfig.url
  || (process.env.APP_DIR ? 'http://127.0.0.1:3100' : 'https://uat1-oc.iviscloud.net/');
const video = reports.video === false
  ? 'off'
  : {
      mode: 'on',
      size: { width: 1920, height: 1080 },
    };
module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/L1-flow.spec.ts',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: reporters,
  outputDir: 'test-results',
  use: {
    baseURL,
    headless: false,
    viewport: null,
    launchOptions: { args: ['--start-maximized'] },
    serviceWorkers: 'block',
    trace: reports.trace === false ? 'off' : 'on',
    screenshot: reports.screenshot === false ? 'off' : 'on',
    video
  },
  webServer: process.env.APP_DIR && !process.env.BASE_URL ? {
    command: 'npm start',
    cwd: path.resolve(process.env.APP_DIR),
    url: baseURL,
    timeout: 300000,
    reuseExistingServer: false,
    env: { BROWSER: 'none', HOST: '127.0.0.1', PORT: '3100', HTTPS: 'false' }
  } : undefined
});
