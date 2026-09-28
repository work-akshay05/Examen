import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { User } from '../models/User.js';

const roleSchema = z.object({ role: z.enum(['marketing', 'reviewer']) }).strict();

function publicUser(user) {
  return { id: String(user._id), name: user.name, email: user.email, role: user.role };
}

export function userRoutes(config, UserModel = User) {
  const router = Router();
  router.use(authenticate(config, UserModel), requireRole('admin'));

  router.get('/', async (_req, res, next) => {
    try {
      const users = await UserModel.find({}, { passwordHash: 0 }).sort({ name: 1 }).lean();
      return res.json({ users: users.map(publicUser) });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:id/role', async (req, res, next) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Role must be marketing or reviewer' });
    if (String(req.auth.userId) === String(req.params.id)) {
      return res.status(400).json({ error: 'You cannot change your own role' });
    }

    try {
      const user = await UserModel.findById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.role === 'admin') return res.status(400).json({ error: 'Admin roles cannot be changed here' });
      user.role = parsed.data.role;
      await user.save();
      return res.json({ user: publicUser(user) });
    } catch (error) {
      if (error?.name === 'CastError') return res.status(400).json({ error: 'Invalid user id' });
      return next(error);
    }
  });

  return router;
}
