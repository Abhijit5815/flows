import { Router } from 'express';
import { API_VERSION } from '@/config';
import { requireAuth, requireRole } from '@/middleware/auth';
import { AdminRoutes } from './admin.routes';
import cartRouter from './cart.routes';
import ordersRouter from './orders.routes';
import { crudRouter } from './products.routes';
import usersRouter from './users.routes';

export const api = Router();
const v1 = Router();

api.use(API_VERSION, v1);

// Mounted in a loop over constant prefixes.
const MOUNTS = [
  { prefix: '/users', router: usersRouter },
  { prefix: '/orders', router: ordersRouter },
  { prefix: '/cart', router: cartRouter },
];
for (const { prefix, router } of MOUNTS) v1.use(prefix, router);

v1.use('/products', crudRouter('product'));

// Admin routes carry their own /admin path and sit behind two guards.
[new AdminRoutes()].forEach((routes) => v1.use(requireAuth, requireRole('admin'), routes.router));
