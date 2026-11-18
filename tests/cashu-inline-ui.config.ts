import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
const output=resolve(process.env.QUIET_LEDGER_CASHU_INLINE_ARTIFACTS??'.runtime/cashu-inline-ui-artifacts');
export default defineConfig({testDir:'.',testMatch:'cashu-inline-ui.spec.ts',workers:1,timeout:25000,outputDir:resolve(output,'results'),reporter:[['list'],['json',{outputFile:resolve(output,'report.json')}]],use:{baseURL:'http://127.0.0.1:4366',browserName:'chromium',headless:true,launchOptions:{executablePath:'/usr/bin/chromium'},acceptDownloads:true},webServer:{cwd:resolve(import.meta.dirname,'..'),command:'node --import tsx tests/fixtures/cashu-inline-server.ts',url:'http://127.0.0.1:4366/tests/fixtures/cashu-inline-ui.html',timeout:30000,reuseExistingServer:false}});
