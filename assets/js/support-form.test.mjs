import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./support-form.js', import.meta.url), 'utf8');
test('contact fields follow choice, including restored browser state', () => {
  const handlers = {};
  const preference = { value: 'anonymous', addEventListener: (event, fn) => { handlers[event] = fn; } };
  const email = {}, name = {}, fields = {};
  const form = { elements: { contact_preference: preference, email, name }, querySelector: () => fields };
  vm.runInNewContext(source, {
    document: { querySelector: () => form },
    window: { addEventListener: (event, fn) => { handlers[event] = fn; } },
  });
  assert.equal(fields.hidden, true);
  assert.equal(email.disabled, true);
  assert.equal(name.disabled, true);
  assert.equal(email.required, false);
  for (const choice of ['reply']) {
    preference.value = choice;
    handlers.change();
    assert.equal(fields.hidden, false);
    assert.equal(email.disabled, false);
    assert.equal(name.disabled, false);
    assert.equal(email.required, true);
  }
  preference.value = 'anonymous';
  handlers.pageshow();
  assert.equal(fields.hidden, true);
  assert.equal(email.disabled, true);
});

test('script is harmless on a page without the support form', () => {
  vm.runInNewContext(source, { document: { querySelector: () => null } });
});
