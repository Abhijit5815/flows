import { Hono } from 'hono';

const app = new Hono();

app.get('/health', (c) => c.text('ok'));
app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }));
app.post('/users', async (c) => c.json(await c.req.json(), 201));

export default app;
