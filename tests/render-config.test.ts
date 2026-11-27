import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const renderConfig = readFileSync(join(process.cwd(), 'render.yaml'), 'utf8');

test('render accepts deployments from the verified production workflow', () => {
  assert.match(renderConfig, /^\s+name: smartstore-ai-marketplace$/m);
  assert.match(renderConfig, /^\s+plan: 1c-2g$/m);
  assert.match(renderConfig, /^\s+region: frankfurt$/m);
  assert.match(renderConfig, /^\s+branch: production$/m);
  assert.match(renderConfig, /^\s+autoDeployTrigger: off$/m);
  assert.match(renderConfig, /domains:\s+- souqhamad\.com/);
  assert.match(renderConfig, /^\s+healthCheckPath: \/api\/health$/m);
});

test('render loads the production configuration before starting the server', () => {
  assert.match(renderConfig, /node -e "Object\.assign\(process\.env,require\('\/etc\/secrets\/production\.json'\)\); import\('\.\/scripts\/start\.mjs'\)"/);
  assert.match(renderConfig, /key: SMARTSTORE_MARKETPLACE_STORE\s+value: database/);
  assert.doesNotMatch(renderConfig, /^\s+preDeployCommand:/m);
});

test('render installs with pinned pnpm and includes build dependencies', () => {
  assert.match(renderConfig, /corepack prepare pnpm@10\.32\.1 --activate &&\s+corepack pnpm install --frozen-lockfile --prod=false &&\s+corepack pnpm build/);
});

test('render pins the production Node major version', () => {
  assert.match(renderConfig, /key: NODE_VERSION\s+value: "24"/);
});

test('production startup rejects incomplete database and authentication configuration', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, SMARTSTORE_MARKETPLACE_STORE: 'database' };
  Reflect.deleteProperty(env, 'NODE_ENV');
  Reflect.deleteProperty(env, 'DATABASE_URL');
  const noDatabase = spawnSync(process.execPath, ['scripts/start.mjs'], { env, encoding: 'utf8', timeout: 5_000 });
  assert.equal(noDatabase.status, 1);
  assert.match(noDatabase.stderr, /DATABASE_URL must identify a PostgreSQL database/);

  const invalidSecret = 'replace-with-a-long-placeholder-secret-for-testing';
  const unsafeAuth = spawnSync(process.execPath, ['scripts/start.mjs'], {
    env: { ...env, DATABASE_URL: 'postgresql://localhost/synthetic', AUTH_SECRET: invalidSecret }, encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(unsafeAuth.status, 1);
  assert.match(unsafeAuth.stderr, /AUTH_SECRET must contain at least 32 characters/);
  assert.ok(!unsafeAuth.stderr.includes(invalidSecret));
});
