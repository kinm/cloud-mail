const perPage = 50;

export async function ensureEmailRoute(env, email) {
	const { CF_EMAIL_ROUTING_TOKEN: token, CF_EMAIL_ROUTING_ZONE_ID: zoneId, cf_email_routing_worker: worker } = env;
	if (!token || !/^[a-f0-9]{32}$/i.test(zoneId) || !worker) {
		throw new Error('Email Routing credentials are incomplete');
	}

	const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules`;
	const signal = AbortSignal.timeout(8000);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const request = async (path, method, body) => {
		const response = await fetch(path, { method, headers, body, signal, redirect: 'error' });
		const data = await response.json().catch(() => null);
		if (!response.ok || data?.success !== true) {
			const code = data?.errors?.[0]?.code;
			throw new Error(`Email Routing ${method} failed: HTTP ${response.status}, code ${Number.isInteger(code) ? code : 'none'}`);
		}
		return data;
	};
	const matching = rule => rule.matchers?.some(matcher =>
		matcher.type === 'literal' && matcher.field === 'to' && matcher.value?.toLowerCase() === email);
	const routesToWorker = rule => rule.enabled === true && rule.actions?.length === 1 &&
		rule.actions[0].type === 'worker' && rule.actions[0].value?.length === 1 && rule.actions[0].value[0] === worker;

	let found = false;
	for (let page = 1; ; page++) {
		const data = await request(`${url}?per_page=${perPage}&page=${page}`, 'GET');
		if (!Array.isArray(data.result)) throw new Error('Email Routing API returned an invalid rule list');
		for (const rule of data.result.filter(matching)) {
			if (!routesToWorker(rule)) return 'conflict';
			found = true;
		}
		const totalPages = data.result_info?.total_pages;
		if (Number.isInteger(totalPages) ? page >= totalPages : data.result.length < perPage) break;
	}
	if (found) return 'ready';

	const { result } = await request(url, 'POST', JSON.stringify({
		enabled: true,
		matchers: [{ type: 'literal', field: 'to', value: email }],
		actions: [{ type: 'worker', value: [worker] }],
	}));
	if (!result || !matching(result) || !routesToWorker(result)) {
		throw new Error('Email Routing API did not confirm the new rule');
	}
	return 'ready';
}
