import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureEmailRoute } from '../src/service/email-routing.js';

const env = {
	CF_EMAIL_ROUTING_TOKEN: 'test-token',
	CF_EMAIL_ROUTING_ZONE_ID: 'a'.repeat(32),
	cf_email_routing_worker: 'cloud-mail',
};
const email = 'support@mail.example.com';
const rule = {
	enabled: true,
	matchers: [{ type: 'literal', field: 'to', value: email }],
	actions: [{ type: 'worker', value: ['cloud-mail'] }],
};
const ok = (result, result_info) => Response.json({ success: true, result, result_info });

test('creates an enabled literal rule for an unused address', async (t) => {
	const fetchMock = t.mock.method(globalThis, 'fetch', async (url, init) => {
		assert.equal(new URL(url).pathname, `/client/v4/zones/${env.CF_EMAIL_ROUTING_ZONE_ID}/email/routing/rules`);
		assert.equal(init.headers.Authorization, 'Bearer test-token');
		if (init.method === 'POST') {
			assert.deepEqual(JSON.parse(init.body), rule);
			return ok(rule);
		}
		return ok([]);
	});
	assert.equal(await ensureEmailRoute(env, email), 'ready');
	assert.equal(fetchMock.mock.callCount(), 2);
});

test('reuses a matching rule on a later page without creating a duplicate', async (t) => {
	const fetchMock = t.mock.method(globalThis, 'fetch', async (url, init) => {
		assert.equal(init.method, 'GET');
		const page = new URL(url).searchParams.get('page');
		return ok(page === '1' ? [] : [{ ...rule, matchers: [{ ...rule.matchers[0], value: email.toUpperCase() }] }], { total_pages: 2 });
	});
	assert.equal(await ensureEmailRoute(env, email), 'ready');
	assert.equal(fetchMock.mock.callCount(), 2);
});

test('fails closed on disabled or conflicting rules, including duplicates', async (t) => {
	for (const conflicting of [{ ...rule, enabled: false }, { ...rule, actions: [{ type: 'forward', value: ['other@example.com'] }] }]) {
		const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, init) => {
			assert.equal(init.method, 'GET');
			return ok([rule, conflicting]);
		});
		assert.equal(await ensureEmailRoute(env, email), 'conflict');
		assert.equal(fetchMock.mock.callCount(), 1);
		fetchMock.mock.restore();
	}
});

test('rechecks existing rules on retry after a lost create response', async (t) => {
	const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, init) => {
		if (init.method === 'POST') throw new TypeError('Connection lost');
		return ok(fetchMock.mock.callCount() === 0 ? [] : [rule]);
	});
	await assert.rejects(ensureEmailRoute(env, email));
	assert.equal(await ensureEmailRoute(env, email), 'ready');
	assert.equal(fetchMock.mock.callCount(), 3);
});
