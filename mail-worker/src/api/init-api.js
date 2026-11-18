import app from '../hono/hono';
import { dbInit } from '../init/init';

app.get('/init/:secret', (c) => {
	return dbInit.init(c, c.req.param('secret'));
})

app.post('/init', (c) => {
	const authorization = c.req.header('Authorization');
	return dbInit.init(c, authorization?.match(/^Bearer (\S+)$/i)?.[1]);
})
