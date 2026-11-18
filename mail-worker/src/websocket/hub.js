import { DurableObject } from 'cloudflare:workers';
import { ensureEmailRoute, removeOwnedEmailRoute } from '../service/email-routing';

// 每个用户一个实例（按 userId 命名），全部邮件共用 ALL_EMAIL_HUB。
// 使用 Hibernation WebSocket：空闲可休眠，连接仍保持。
export class MailHub extends DurableObject {
	// 同一地址的创建和删除按顺序执行，避免删除时有另一个请求重新创建规则。
	#withRouteLock(operation) {
		const result = (this.routeSync ?? Promise.resolve()).then(operation);
		const pending = result.catch(() => {});
		this.routeSync = pending;
		return result.finally(() => {
			if (this.routeSync === pending) this.routeSync = undefined;
		});
	}

	async syncEmailRoute(email, accountId, restore = false) {
		return this.#withRouteLock(async () => {
			const stored = await this.ctx.storage.get('emailRoute');
			const owned = stored?.accountId === accountId ? stored : null;
			if (restore && !owned?.removed && !owned?.restorePending) return 'ready';
			const active = await this.env.db.prepare('SELECT 1 FROM account WHERE account_id = ? AND email = ? COLLATE NOCASE AND is_del = 0')
				.bind(accountId, email).first();
			if (!active) return 'inactive';
			const zoneId = this.env.CF_EMAIL_ROUTING_ZONE_ID;
			const worker = this.env.cf_email_routing_worker;
			const claim = owned && !owned.removed && owned.zoneId === zoneId && owned.worker === worker ? owned : {
				accountId, zoneId, worker, name: `Cloud Mail ${crypto.randomUUID()}`,
			};
			const result = await ensureEmailRoute(this.env, email, claim, name => this.ctx.storage.put('emailRoute', {
				accountId, zoneId, worker, name, pendingSince: Date.now(), restorePending: restore || owned?.restorePending || false,
			}));
			if (result.status === 'ready') {
				if (result.id) {
					await this.ctx.storage.put('emailRoute', { accountId, zoneId, worker, id: result.id, name: result.name });
				} else if (owned) {
					await this.ctx.storage.delete('emailRoute');
				}
			}
			return result.status;
		});
	}

	async deleteMailboxRoute(email, accountId) {
		return this.#withRouteLock(async () => {
			const claim = await this.ctx.storage.get('emailRoute');
			if (claim?.accountId === accountId && !claim.removed) {
				if (await removeOwnedEmailRoute(this.env, email, claim)) {
					await this.ctx.storage.put('emailRoute', { ...claim, removed: true });
				} else {
					await this.ctx.storage.delete('emailRoute');
				}
			}
			await this.env.db.prepare('UPDATE account SET is_del = 1 WHERE account_id = ? AND email = ? COLLATE NOCASE')
				.bind(accountId, email).run();
		});
	}

	// 接受浏览器的 WebSocket 升级，接入当前 hub。
	async fetch(request) {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected WebSocket upgrade', { status: 426 });
		}

		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	// 向本 hub 上所有连接推送新邮件摘要。出站消息不计请求。
	async notify(payload) {
		const message = JSON.stringify(payload);
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(message);
			} catch {
				socket.close(1011, 'Delivery failed');
			}
		}
	}

	// 处理客户端心跳：ping / { type: 'ping' } 回 pong，避免中间代理掐线。
	async webSocketMessage(socket, message) {
		if (message === 'ping') {
			socket.send('pong');
			return;
		}
		if (typeof message !== 'string') {
			return;
		}
		try {
			const parsed = JSON.parse(message);
			if (parsed?.type === 'ping') {
				socket.send('pong');
			}
		} catch {
			// ignore malformed client frames
		}
	}

	// 客户端断开时关闭服务端套接字，便于对象休眠。
	async webSocketClose(socket, code) {
		socket.close(code, 'Durable Object is closing WebSocket');
	}
}
