import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
const artifacts=resolve(process.env.QUIET_LEDGER_MARMOT_ARTIFACTS??'.runtime/conversations-ui-artifacts');
export default defineConfig({
  testDir:'.',testMatch:'conversations-ui.spec.ts',workers:1,fullyParallel:false,
  timeout:25_000,expect:{timeout:5000},outputDir:resolve(artifacts,'results'),
  reporter:[['list'],['json',{outputFile:resolve(artifacts,'report.json')}]],
  use:{baseURL:'http://127.0.0.1:4338',browserName:'chromium',headless:true,launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium'},trace:'retain-on-failure'},
  webServer:{command:'node --import tsx tests/conversations-ui-app.ts',cwd:resolve(import.meta.dirname,'..'),url:'http://127.0.0.1:4338/tests/fixtures/conversations-ui.html',timeout:30000,reuseExistingServer:false},
});
