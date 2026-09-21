const { defineConfig } = require('@playwright/test');
const path = require('node:path');
const baseURL = process.env.BASE_URL || (process.env.APP_DIR ? 'http://127.0.0.1:3100' : 'https://uat1-oc.iviscloud.net/');
module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/L1-flow.spec.ts',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['junit', { outputFile: 'reports/junit.xml' }]],
  outputDir: 'test-results',
  use: {
    baseURL,
    headless: false,
    viewport: null,
    launchOptions: { args: ['--start-maximized'] },
    serviceWorkers: 'block',
    trace: 'on',
    screenshot: 'only-on-failure',
    video: { mode: 'on', size: { width: 1920, height: 1080 } }
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
