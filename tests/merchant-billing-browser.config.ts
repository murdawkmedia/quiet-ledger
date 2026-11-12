import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';

// Focused merchant-billing browser suite. The spec starts its own real-app fixture on
// the dedicated loopback port 4362 (checked unused; no other listener is touched).
// Keep reports in a dedicated directory; Playwright clears its output directory.
const artifacts=resolve(process.env.QUIET_LEDGER_MERCHANT_BILLING_ARTIFACTS??'.runtime/merchant-billing-artifacts');
export default defineConfig({
  testDir:'./browser',
  testMatch:'merchant-billing-live.spec.ts',
  workers:1,
  timeout:120000,
  expect:{timeout:8000},
  outputDir:resolve(artifacts,'results'),
  reporter:[['list']],
  use:{
    baseURL:'http://127.0.0.1:4362',
    browserName:'chromium',
    headless:true,
    actionTimeout:10000,
    launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium'},
    trace:'retain-on-failure'
  }
});
