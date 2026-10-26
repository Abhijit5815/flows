import { Router } from 'express';
import * as users from '@/controllers/users.controller';
import { requireAuth } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { loginSchema, registerSchema, updateMeSchema, updateUserSchema } from '@/schemas/user.schema';

const router = Router();

router.post('/register', validate(registerSchema), users.register);
router.post('/login', validate(loginSchema), users.login);
router.post('/logout', requireAuth, users.logout);
router.get('/me', requireAuth, users.me);
router.patch('/me', requireAuth, validate(updateMeSchema), users.updateMe);
router
  .route('/:id')
  .get(requireAuth, users.getById)
  .patch(requireAuth, validate(updateUserSchema), users.update);

export default router;
