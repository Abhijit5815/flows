import express from 'express';
import { API_PREFIX } from './config';
import { api } from './routes';

export const app = express();

app.use(express.json());
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});
app.use(API_PREFIX, api);

// The path comes from the environment, so it is not known from source.
app.get(process.env.STATUS_PATH ?? '/status', (req, res) => res.sendStatus(204));

// Registered with a computed method name, which no route rule matches.
for (const method of ['get', 'head'] as const) app[method]('/ping', (req, res) => res.sendStatus(204));

app.listen(Number(process.env.PORT ?? 3000));
