import { Router } from 'express';
import { orders } from '@/controllers/orders.controller';
import { requireAuth } from '@/middleware/auth';

const ORDER_ID = '/:orderId';

const router = Router();

// Every order route needs a signed-in user.
router.use(requireAuth);

router.route('/').get(orders.list).post(orders.create);
router.get(ORDER_ID, orders.getById);
router.delete(`${ORDER_ID}`, orders.cancel);

export default router;
