import {defineConfig} from '@playwright/test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

// Reuse the ledger fixture server and bootstrap on this suite's isolated port.
const root=resolve(import.meta.dirname,'..');
const fixtureServer=readFileSync(resolve(root,'tests/invoice-ledger-ui-app.ts'),'utf8');
if(!fixtureServer.includes('port:4347'))throw new Error('Ledger fixture server port changed; review currency-report isolation.');
mkdirSync(resolve(root,'.runtime'),{recursive:true});
writeFileSync(resolve(root,'.runtime/currency-report-ui-app.ts'),fixtureServer.replace('port:4347','port:4348'));

export default defineConfig({
  testDir:'.',testMatch:'currency-report-ui.spec.ts',workers:1,timeout:25000,expect:{timeout:5000},
  outputDir:resolve(root,'.runtime/currency-report-ui-results'),reporter:[['list']],
  use:{actionTimeout:6000,baseURL:'http://127.0.0.1:4348',browserName:'chromium',headless:true,viewport:{width:1440,height:1100},launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium'}},
  webServer:{command:'node --import tsx .runtime/currency-report-ui-app.ts',cwd:root,url:'http://127.0.0.1:4348/tests/fixtures/invoice-ledger-ui.html',reuseExistingServer:false},
});
