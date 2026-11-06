import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
export default defineConfig({testDir:'.',testMatch:'recurring-ui.spec.ts',workers:1,timeout:25000,expect:{timeout:5000},outputDir:'.runtime/recurring-ui-results',reporter:[['list']],use:{baseURL:'http://127.0.0.1:4358',browserName:'chromium',headless:true,launchOptions:{executablePath:'/usr/bin/chromium'}},webServer:{command:'node --import tsx tests/recurring-ui-app.ts',cwd:resolve(import.meta.dirname,'..'),url:'http://127.0.0.1:4358/tests/fixtures/recurring-ui.html',reuseExistingServer:false}});
