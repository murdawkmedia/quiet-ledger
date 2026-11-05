import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
const runtimeDirectory=resolve(process.env.DATA_DIR??'.runtime').replaceAll('\\','/');
const scenarioPath=process.env.PRIVATE_SCENARIO_PATH?resolve(process.env.PRIVATE_SCENARIO_PATH).replaceAll('\\','/'):undefined;
const squareTokenPath=process.env.SQUARE_SANDBOX_TOKEN_FILE?resolve(process.env.SQUARE_SANDBOX_TOKEN_FILE).replaceAll('\\','/'):undefined;
const receivingConfigPath=process.env.RECEIVING_CONNECTIONS_FILE?resolve(process.env.RECEIVING_CONNECTIONS_FILE).replaceAll('\\','/'):undefined;
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    fs: {
      deny: ['**/.env', '**/.env.*', '**/*.{crt,pem}', '**/.git/**', '**/.runtime/**', '**/private-data/**', '**/*owner-token*', '**/*api-token*', '**/*sandbox-token*', '**/*receiving-connections*', '**/*.sqlite*', '**/*.db', `${runtimeDirectory}/**`, ...(scenarioPath?[scenarioPath]:[]), ...(squareTokenPath?[squareTokenPath]:[]),...(receivingConfigPath?[receivingConfigPath]:[])],
    },
  },
});
