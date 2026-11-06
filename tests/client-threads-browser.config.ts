import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
export default defineConfig({testDir:'./browser',testMatch:'client-threads.spec.ts',workers:1,timeout:30000,expect:{timeout:5000},outputDir:'.runtime/client-threads-results',reporter:[['list']],use:{baseURL:'http://localhost:4354',browserName:'chromium',headless:true,launchOptions:{executablePath:'/usr/bin/chromium'}},webServer:{command:'node --import tsx tests/invoice-email-ui-app.ts',cwd:resolve(import.meta.dirname,'..'),url:'http://localhost:4354/api/health',reuseExistingServer:false,timeout:30000}});
