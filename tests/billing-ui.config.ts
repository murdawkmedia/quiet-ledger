import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
// Focused billing browser suite on its own loopback port; artifacts stay out of
// the source tree in the task's evidence folder. No external network is touched.
const artifacts=resolve(process.env.QUIET_LEDGER_BILLING_ARTIFACTS??'.runtime/billing-ui-artifacts');
export default defineConfig({testDir:'.',testMatch:'billing-ui.spec.ts',workers:1,timeout:25000,expect:{timeout:5000},outputDir:resolve(artifacts,'results'),reporter:[['list']],use:{baseURL:'http://127.0.0.1:4361',browserName:'chromium',headless:true,launchOptions:{executablePath:'/usr/bin/chromium'}},webServer:{command:'node --import tsx tests/billing-ui-app.ts',cwd:resolve(import.meta.dirname,'..'),url:'http://127.0.0.1:4361/tests/fixtures/billing-ui.html',reuseExistingServer:false}});
