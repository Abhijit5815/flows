import { Router } from 'express';
import * as cart from '@/controllers/cart.controller';
import { requireAuth } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { addItemSchema } from '@/schemas/cart.schema';

const router = Router();

// The signed-in user's cart.
router.use(requireAuth);

router.get('/', cart.list);
router.post('/items', validate(addItemSchema), cart.addItem);

export default router;
