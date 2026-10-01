import fs from 'node:fs/promises';

const sourcePath = new URL('./batch-apply-all-v3.js', import.meta.url);
const runtimePath = new URL('./.batch-apply-all-v4-runtime.mjs', import.meta.url);
let source = await fs.readFile(sourcePath, 'utf8');

const oldMeta = `await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), form.locator('button[type=\"submit\"],input[type=\"submit\"]').last().click()]);`;
const newMeta = `await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), form.evaluate(f => f.requestSubmit())]);`;
const oldTitle = `await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), current.form.locator('button[type=\"submit\"],input[type=\"submit\"]').last().click()]);`;
const newTitle = `await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), current.form.evaluate(f => f.requestSubmit())]);`;

if (!source.includes(oldMeta)) throw new Error('V4 patch guard: metadata submit expression not found');
if (!source.includes(oldTitle)) throw new Error('V4 patch guard: translation submit expression not found');
source = source.replace(oldMeta, newMeta).replace(oldTitle, newTitle);
source = source.replace("mode: 'BATCH_APPLY_ALL_V3_SAFE_RESUME'", "mode: 'BATCH_APPLY_ALL_V4_NATIVE_SUBMIT'");
source = source.replace("reports/batch-apply-all-v3.json", "reports/batch-apply-all-v4.json");
source = source.replace("reports/batch-apply-all-v3.txt", "reports/batch-apply-all-v4.txt");

await fs.writeFile(runtimePath, source, 'utf8');
try {
  await import(runtimePath.href + `?t=${Date.now()}`);
} finally {
  await fs.rm(runtimePath, { force: true });
}
