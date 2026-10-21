import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { OptionalLlm } from '../engine/llm.ts';
import type { LlmGateway, LlmRequest } from '../llm/gateway.ts';
import { browserSkip } from '../shared/testing/browser.ts';
import { launchBrowser, newContext } from './browser.ts';
import { look } from './capture.ts';
import { fillForm } from './forms.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-forms-'));
let browser: Browser;
before(async () => {
  if (browserSkip === false) browser = (await launchBrowser(undefined, true)).browser;
});
after(async () => {
  await browser?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const FORM = '<form><label>Name <input name="name" required></label><label>Voucher <input name="code" pattern="[A-Z]{3}-\\d{3}" required></label><select name="size"><option value="">Pick</option><option value="m">M</option></select><button>Redeem</button></form>';

// An LLM stand-in that answers the form question with the given values, and counts the calls.
const llm = (values: Record<string, string>) => {
  const calls: string[] = [];
  const gateway: LlmGateway = {
    model: 'fake',
    async completeJson<T>(request: LlmRequest<T>): Promise<T> {
      calls.push(request.prompt);
      return request.schema.parse({ values });
    },
  };
  return { calls, optional: new OptionalLlm(gateway, join(tmp, `llm-${Math.random()}.json`), () => undefined) };
};

async function form() {
  const page = await (await newContext(browser)).newPage();
  await page.setContent(FORM);
  const fields = (await look(page)).forms[0].fields;
  return { page, fields, locator: page.locator('form') };
}

test('rules fill what they can; the LLM is asked only for the field the browser still rejects', { skip: browserSkip }, async () => {
  const { page, fields, locator } = await form();
  const { calls, optional } = llm({ code: 'ABC-123' });
  assert.deepEqual(await fillForm(locator, fields, optional), { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0]).map((field: { name: string }) => field.name), ['code'], 'only the rejected field was asked about');
  assert.equal(await page.locator('[name=name]').inputValue(), 'test');
  assert.equal(await page.locator('[name=size]').inputValue(), 'm');
  await page.context().close();
});

test("an LLM value the browser rejects isn't used, and without an LLM the form is left unsubmitted with the reason", { skip: browserSkip }, async () => {
  const bad = await form();
  const result = await fillForm(bad.locator, bad.fields, llm({ code: 'nope' }).optional);
  assert.deepEqual(result, { ok: false, reason: "the browser still rejects code after the LLM's values" });
  await bad.page.context().close();
  const none = await form();
  assert.deepEqual(await fillForm(none.locator, none.fields, new OptionalLlm(undefined, join(tmp, 'none.json'), () => undefined)), { ok: false, reason: 'the browser rejects code, and no LLM answer is available' });
  await none.page.context().close();
});
