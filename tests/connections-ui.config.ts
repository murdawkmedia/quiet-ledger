import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
const artifacts=resolve(process.env.QUIET_LEDGER_CONNECTION_ARTIFACTS??'.runtime/connections-ui-artifacts');
export default defineConfig({
  testDir:'.',testMatch:'connections-ui.spec.ts',workers:1,fullyParallel:false,
  timeout:25_000,expect:{timeout:5000},outputDir:resolve(artifacts,'results'),
  reporter:[['list'],['json',{outputFile:resolve(artifacts,'report.json')}]],
  use:{baseURL:'http://127.0.0.1:4334',browserName:'chromium',headless:true,launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium'},trace:'retain-on-failure'},
  webServer:{command:'node --import tsx tests/connections-ui-app.ts',cwd:resolve(import.meta.dirname,'..'),url:'http://127.0.0.1:4334/tests/fixtures/connections-ui.html',timeout:30000,reuseExistingServer:false},
});
