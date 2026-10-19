import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CategorySchema, DEFAULT_CATEGORIES, FALLBACK_CATEGORY_ID } from './category.ts';

test('default categories are valid and have unique ids', () => {
  for (const category of DEFAULT_CATEGORIES) {
    assert.ok(CategorySchema.safeParse(category).success, `invalid default category "${category.id}"`);
  }
  const ids = DEFAULT_CATEGORIES.map((category) => category.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate category id');
});

test('the fallback category exists and cannot be edited', () => {
  const fallback = DEFAULT_CATEGORIES.find((category) => category.id === FALLBACK_CATEGORY_ID);
  assert.ok(fallback, 'fallback category missing');
  assert.equal(fallback.editable, false);
});

test('category schema rejects a bad colour and a bad id', () => {
  const valid = { id: 'auth', name: 'Sign-in', color: '#0072B2', editable: true };
  assert.ok(CategorySchema.safeParse(valid).success);
  assert.equal(CategorySchema.safeParse({ ...valid, color: 'blue' }).success, false);
  assert.equal(CategorySchema.safeParse({ ...valid, id: 'Sign In' }).success, false);
});
