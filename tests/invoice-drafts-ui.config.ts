import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
// Focused saved-invoice-draft browser suite on its own loopback port with a
// route-mocked backend; artifacts stay out of the source tree. No network.
const artifacts=resolve(process.env.QUIET_LEDGER_INVOICE_DRAFTS_ARTIFACTS??'.runtime/invoice-drafts-ui-artifacts');
export default defineConfig({testDir:'.',testMatch:'invoice-drafts-ui.spec.ts',workers:1,timeout:30000,expect:{timeout:8000},outputDir:resolve(artifacts,'results'),reporter:[['list']],use:{baseURL:'http://127.0.0.1:4365',browserName:'chromium',headless:true,launchOptions:{executablePath:'/usr/bin/chromium'}},webServer:{command:'node --import tsx tests/invoice-drafts-ui-app.ts',cwd:resolve(import.meta.dirname,'..'),url:'http://127.0.0.1:4365/tests/fixtures/invoice-drafts-ui.html',reuseExistingServer:false}});
