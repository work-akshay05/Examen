import { Router } from 'express';
import { z } from 'zod';
import { createAccessToken, hashPassword, verifyPassword } from '../auth.js';
import { User } from '../models/User.js';

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(128)
}).strict();
const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(128) }).strict();
const publicUser = (user) => ({ id: String(user._id), name: user.name, email: user.email, role: user.role });

export function authRoutes(config) {
  const router = Router();

  router.post('/register', async (req, res, next) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid registration details', details: parsed.error.flatten().fieldErrors });
    try {
      const { name, email, password } = parsed.data;
      const normalizedEmail = email.toLowerCase();
      if (await User.exists({ email: normalizedEmail })) return res.status(409).json({ error: 'An account with that email already exists' });
      const user = await User.create({ name, email: normalizedEmail, passwordHash: await hashPassword(password), role: 'marketing' });
      return res.status(201).json({ user: publicUser(user), token: createAccessToken(user, config) });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ error: 'An account with that email already exists' });
      return next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid login details' });
    try {
      const user = await User.findOne({ email: parsed.data.email.toLowerCase() }).select('+passwordHash');
      if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
        return res.status(401).json({ error: 'Email or password is incorrect' });
      }
      return res.json({ user: publicUser(user), token: createAccessToken(user, config) });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
