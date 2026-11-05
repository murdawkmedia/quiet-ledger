import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
const artifacts=resolve(process.env.QUIET_LEDGER_SAVED_CONNECTION_ARTIFACTS??'.runtime/saved-connection-browser-artifacts');
export default defineConfig({
  testDir:'./browser',testMatch:'saved-connections.spec.ts',workers:1,fullyParallel:false,
  timeout:45_000,expect:{timeout:8000},outputDir:resolve(artifacts,'results'),
  reporter:[['list'],['json',{outputFile:resolve(artifacts,'report.json')}]],
  use:{baseURL:'http://localhost:4333',browserName:'chromium',headless:true,launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium'},trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{command:'node --import tsx tests/saved-connections-app.ts',cwd:resolve(import.meta.dirname,'..'),url:'http://localhost:4333/api/health',timeout:30000,reuseExistingServer:false},
});
