import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
const artifacts=resolve(process.env.QUIET_LEDGER_MARMOT_REAL_ARTIFACTS??'.runtime/marmot-demo-browser-artifacts');
export default defineConfig({
  testDir:'./browser',testMatch:['marmot-demo.spec.ts','marmot-invoice.spec.ts'],workers:1,fullyParallel:false,
  timeout:90_000,expect:{timeout:15000},outputDir:resolve(artifacts,'results'),
  reporter:[['list'],['json',{outputFile:resolve(artifacts,'report.json')}]],
  use:{baseURL:'http://localhost:4335',browserName:'chromium',headless:true,launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium'},trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{command:'node --import tsx tests/marmot-demo-app.ts',cwd:resolve(import.meta.dirname,'..'),url:'http://localhost:4335/api/health',timeout:30000,reuseExistingServer:false},
});
