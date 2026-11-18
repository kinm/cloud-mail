import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureEmailRoute, removeOwnedEmailRoute } from '../src/service/email-routing.js';

const env = {
	CF_EMAIL_ROUTING_TOKEN: 'test-token',
	CF_EMAIL_ROUTING_ZONE_ID: 'a'.repeat(32),
	cf_email_routing_worker: 'cloud-mail',
};
const email = 'support@mail.example.com';
const claim = { name: 'Cloud Mail example-id', zoneId: env.CF_EMAIL_ROUTING_ZONE_ID, worker: 'cloud-mail' };
const id = 'b'.repeat(32);
const rule = {
	enabled: true,
	matchers: [{ type: 'literal', field: 'to', value: email }],
	actions: [{ type: 'worker', value: ['cloud-mail'] }],
};
const ok = (result, result_info) => Response.json({ success: true, result, result_info });
const ownedRule = { ...rule, name: claim.name, id };

test('deletes only the recorded rule even when the same address has a manual rule', async (t) => {
	const fetchMock = t.mock.method(globalThis, 'fetch', async (url, init) => {
		if (init.method === 'GET') return ok([{ ...rule, id, name: claim.name }, { ...rule, id: 'c'.repeat(32) }]);
		assert.equal(init.method, 'DELETE');
		assert.ok(new URL(url).pathname.endsWith('/' + id));
		return ok({ id });
	});
	assert.equal(await removeOwnedEmailRoute(env, email, { ...claim, id }), true);
	assert.equal(fetchMock.mock.callCount(), 2);
});

test('preserves an edited rule, a manual replacement, and rules from another zone', async (t) => {
	const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, init) => {
		assert.equal(init.method, 'GET');
		return ok([{ ...rule, id, name: 'Changed in dashboard' }, { ...rule, id: 'c'.repeat(32), name: claim.name }]);
	});
	assert.equal(await removeOwnedEmailRoute(env, email, { ...claim, id }), false);
	assert.equal(await removeOwnedEmailRoute(env, email, { ...claim, id, zoneId: 'd'.repeat(32) }), false);
	assert.equal(fetchMock.mock.callCount(), 1);
});

test('creates an enabled literal rule for an unused address', async (t) => {
	let saved = false;
	const fetchMock = t.mock.method(globalThis, 'fetch', async (url, init) => {
		assert.equal(new URL(url).pathname, `/client/v4/zones/${env.CF_EMAIL_ROUTING_ZONE_ID}/email/routing/rules`);
		assert.equal(init.headers.Authorization, 'Bearer test-token');
		assert.equal(init.redirect, 'manual');
		if (init.method === 'POST') {
			assert.equal(saved, true);
			assert.deepEqual(JSON.parse(init.body), { ...rule, name: claim.name });
			return ok(ownedRule);
		}
		return ok([]);
	});
	const result = await ensureEmailRoute(env, email, claim, name => {
		assert.equal(name, claim.name);
		saved = true;
	});
	assert.deepEqual(result, { status: 'ready', id, name: claim.name });
	assert.equal(fetchMock.mock.callCount(), 2);
});

test('reuses a matching rule on a later page without creating a duplicate', async (t) => {
	const fetchMock = t.mock.method(globalThis, 'fetch', async (url, init) => {
		assert.equal(init.method, 'GET');
		const page = new URL(url).searchParams.get('page');
		return ok(page === '1' ? [] : [{ ...rule, matchers: [{ ...rule.matchers[0], value: email.toUpperCase() }] }], { total_pages: 2 });
	});
	const result = await ensureEmailRoute(env, email, claim, () => assert.fail('Manual rule already exists'));
	assert.equal(result.status, 'ready');
	assert.equal(result.id, undefined);
	assert.equal(fetchMock.mock.callCount(), 2);
});

test('fails closed on disabled or conflicting rules, including duplicates', async (t) => {
	for (const conflicting of [{ ...rule, enabled: false }, { ...rule, actions: [{ type: 'forward', value: ['other@example.com'] }] }]) {
		const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, init) => {
			assert.equal(init.method, 'GET');
			return ok([rule, conflicting]);
		});
		assert.equal((await ensureEmailRoute(env, email, claim)).status, 'conflict');
		assert.equal(fetchMock.mock.callCount(), 1);
		fetchMock.mock.restore();
	}
});

test('rechecks existing rules on retry after a lost create response', async (t) => {
	const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, init) => {
		if (init.method === 'POST') throw new TypeError('Connection lost');
		return ok(fetchMock.mock.callCount() === 0 ? [] : [ownedRule]);
	});
	await assert.rejects(ensureEmailRoute(env, email, claim, () => {}), /Connection lost/);
	const result = await ensureEmailRoute(env, email, { ...claim, pendingSince: Date.now() });
	assert.deepEqual(result, { status: 'ready', id, name: claim.name });
	assert.equal(fetchMock.mock.callCount(), 3);
});

test('a failed deletion can be retried and an already absent rule is left alone', async (t) => {
	const methods = [];
	const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, init) => {
		methods.push(init.method);
		if (init.method === 'GET') return ok(methods.length < 5 ? [ownedRule] : []);
		return methods.length === 2 ? Response.json({ success: false }, { status: 503 }) : ok({ id });
	});
	await assert.rejects(removeOwnedEmailRoute(env, email, { ...claim, id }), /HTTP 503/);
	assert.equal(await removeOwnedEmailRoute(env, email, { ...claim, id }), true);
	assert.equal(await removeOwnedEmailRoute(env, email, { ...claim, id }), false);
	assert.deepEqual(methods, ['GET', 'DELETE', 'GET', 'DELETE', 'GET']);
	assert.equal(fetchMock.mock.callCount(), 5);
});
