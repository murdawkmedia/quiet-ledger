import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';

const artifacts=resolve(process.env.QUIET_LEDGER_BROWSER_ARTIFACTS??'.runtime/adversarial-browser-artifacts');
export default defineConfig({
  testDir:'./browser',
  testMatch:'adversarial.spec.ts',
  outputDir:resolve(artifacts,'results'),
  timeout:40_000,
  expect:{timeout:6_000},
  fullyParallel:false,
  workers:1,
  reporter:[['list'],['json',{outputFile:resolve(artifacts,'report.json')}],['html',{open:'never',outputFolder:resolve(artifacts,'html')}]],
  use:{baseURL:'http://127.0.0.1:4330',browserName:'chromium',headless:true,launchOptions:{executablePath:'/usr/bin/chromium'},trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{
    command:'node --import tsx tests/browser-app.ts',
    cwd:resolve(import.meta.dirname,'..'),
    url:'http://127.0.0.1:4330/api/health',
    reuseExistingServer:false,
    timeout:60_000,
    env:{PORT:'4330',HOST:'127.0.0.1',DATA_DIR:'.runtime/hardening-browser',OWNER_TOKEN:'hardening-fictional-owner-only',PRIVATE_SCENARIO_PATH:'tests/fixtures/owner-scenario.json',SIMULATION_ONLY:'true',SQUARE_SANDBOX_TOKEN_FILE:'',SQUARE_SANDBOX_LOCATION_ID:'',NODE_ENV:'development'},
  },
});
