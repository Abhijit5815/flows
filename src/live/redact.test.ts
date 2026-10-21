import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyShape, isSecretName, redactHeaders, redactJson, redactPath, redactText, redactUrl } from './redact.ts';

test('secret names are matched by word: access_token and sessionId are, author and keyboard are not', () => {
  for (const name of ['password', 'access_token', 'sessionId', 'apiKey', 'X-Auth-Token', 'cardNumber', 'otp']) assert.ok(isSecretName(name), name);
  for (const name of ['author', 'keyboard', 'name', 'email', 'passenger', 'pinned']) assert.ok(!isSecretName(name), name);
});

test('text loses emails, JWTs, long tokens and long digit runs, and keeps ordinary words and dates', () => {
  assert.equal(redactText('Signed in as ana.lopez@example.com'), 'Signed in as [email]');
  assert.equal(redactText('t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2ln'), 't=[jwt]');
  assert.equal(redactText('key 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'), 'key [token]');
  assert.equal(redactText('tok_Ab3dEf9hIjKlMnOpQrStUvWxYz012345'), '[token]');
  assert.equal(redactText('call +1 (555) 010-0199 or pay with 4111 1111 1111 1111'), 'call [number] or pay with [number]');
  assert.equal(redactText('Order 7 placed on 2026-10-20 for 45.00'), 'Order 7 placed on 2026-10-20 for 45.00');
  assert.equal(redactText('/blog/my-long-post-about-lamps-and-chairs-2026'), '/blog/my-long-post-about-lamps-and-chairs-2026');
});

test('URLs keep their path shape: a secret segment becomes one masked segment, secret query values are masked', () => {
  assert.equal(redactPath('/reset/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2ln/done'), '/reset/[jwt]/done');
  assert.equal(redactUrl('https://app.example.com/users/ana%40example.com?access_token=abc&page=2#top'), 'https://app.example.com/users/[email]?access_token=[redacted]&page=2');
  assert.equal(redactUrl('mailto:help@example.org'), 'mailto:[email]');
});

test('only harmless headers are kept, so cookies and auth headers never are', () => {
  assert.deepEqual(redactHeaders({ 'Content-Type': 'application/json', Authorization: 'Bearer x', cookie: 'sid=1', 'set-cookie': 'sid=1', 'x-api-token': 't', location: '/u/ana@example.com' }), {
    'content-type': 'application/json',
    location: '/u/[email]',
  });
});

test('JSON bodies: secret keys masked, strings redacted, long arrays cut; a blocked body keeps only its shape', () => {
  assert.deepEqual(redactJson({ user: { email: 'ana@example.com', apiToken: 'tok_1', name: 'Ana' }, items: Array.from({ length: 22 }, (_, i) => i) }), {
    user: { email: '[email]', apiToken: '[redacted]', name: 'Ana' },
    items: [...Array.from({ length: 20 }, (_, i) => i), '[2 more]'],
  });
  assert.deepEqual(bodyShape('{"email":"ana@example.com","age":3,"tags":["a"]}', 'application/json'), { email: 'string', age: 'number', tags: ['string'] });
  assert.deepEqual(bodyShape('email=ana%40example.com&password=hunter2', 'application/x-www-form-urlencoded'), { fields: ['email', 'password'] });
  assert.equal(bodyShape(null, undefined), null);
});
