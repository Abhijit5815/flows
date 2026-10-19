import request from 'supertest';
import { app } from '../server';

// Supertest calls look like routes to a naive pattern; they are requests, not routes.
test('health and login', async () => {
  const agent = request.agent(app);
  await agent.get('/health').expect(200);
  await request(app).post('/api/v1/users/login').send({ email: 'a@example.com', password: 'secret123' });
});
