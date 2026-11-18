const perPage = 50;

function routingApi(env) {
	const { CF_EMAIL_ROUTING_TOKEN: token, CF_EMAIL_ROUTING_ZONE_ID: zoneId, cf_email_routing_worker: worker } = env;
	if (!token || !/^[a-f0-9]{32}$/i.test(zoneId) || !worker) {
		throw new Error('Email Routing credentials are incomplete');
	}

	const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules`;
	const signal = AbortSignal.timeout(8000);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const request = async (path, method, body) => {
		const response = await fetch(path, { method, headers, body, signal, redirect: 'manual' });
		if (method === 'DELETE' && response.status === 404) return;
		const data = await response.json().catch(() => null);
		if (!response.ok || data?.success !== true) {
			const code = data?.errors?.[0]?.code;
			throw new Error(`Email Routing ${method} failed: HTTP ${response.status}, code ${Number.isInteger(code) ? code : 'none'}`);
		}
		return data;
	};
	return { url, request, worker };
}

const matchesAddress = (rule, email) => rule.matchers?.some(matcher =>
	matcher.type === 'literal' && matcher.field === 'to' && matcher.value?.toLowerCase() === email);
const routesToWorker = (rule, worker) => rule.enabled === true && rule.actions?.length === 1 &&
	rule.actions[0].type === 'worker' && rule.actions[0].value?.length === 1 && rule.actions[0].value[0] === worker;
const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/i.test(id);
const isOwned = (rule, claim, email) => claim.name?.startsWith('Cloud Mail ') && rule.name === claim.name && rule.source !== 'wrangler' && validId(rule.id) &&
	(!claim.id || rule.id === claim.id) && rule.matchers?.length === 1 &&
	matchesAddress(rule, email) && routesToWorker(rule, claim.worker);

async function matchingRules(api, email) {
	const rules = [];
	for (let page = 1; ; page++) {
		const data = await api.request(`${api.url}?per_page=${perPage}&page=${page}`, 'GET');
		if (!Array.isArray(data.result)) throw new Error('Email Routing API returned an invalid rule list');
		rules.push(...data.result.filter(rule => matchesAddress(rule, email)));
		const totalPages = data.result_info?.total_pages;
		if (Number.isInteger(totalPages) ? page >= totalPages : data.result.length < perPage) break;
	}
	return rules;
}

export async function ensureEmailRoute(env, email, claim, beforeCreate) {
	const api = routingApi(env);
	const rules = await matchingRules(api, email);
	if (rules.some(rule => !routesToWorker(rule, api.worker))) return { status: 'conflict' };
	if (rules.length > 0) {
		const owned = rules.find(rule => isOwned(rule, claim, email));
		return { status: 'ready', id: owned?.id, name: owned?.name };
	}

	if (!claim.id && claim.pendingSince && Date.now() - claim.pendingSince < 30000) {
		throw new Error('Email Routing create result is still pending');
	}
	const name = claim.id ? `Cloud Mail ${crypto.randomUUID()}` : claim.name;
	await beforeCreate(name);
	const { result } = await api.request(api.url, 'POST', JSON.stringify({
		name,
		enabled: true,
		matchers: [{ type: 'literal', field: 'to', value: email }],
		actions: [{ type: 'worker', value: [api.worker] }],
	}));
	if (!result || !isOwned(result, { ...claim, name, id: undefined }, email)) {
		throw new Error('Email Routing API did not confirm the new rule');
	}
	return { status: 'ready', id: result.id, name };
}

export async function removeOwnedEmailRoute(env, email, claim) {
	if (!claim || claim.zoneId !== env.CF_EMAIL_ROUTING_ZONE_ID || claim.worker !== env.cf_email_routing_worker) return false;
	const api = routingApi(env);
	const rules = await matchingRules(api, email);
	const owned = rules.filter(rule => isOwned(rule, claim, email));
	if (!claim.id && owned.length === 0 && claim.pendingSince && Date.now() - claim.pendingSince < 30000) {
		throw new Error('Email Routing create result is still pending');
	}
	if (owned.length !== 1) return false;
	await api.request(`${api.url}/${owned[0].id}`, 'DELETE');
	return true;
}
