import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from './models/User.js';

export const roles = Object.freeze({ MARKETING: 'marketing', REVIEWER: 'reviewer', ADMIN: 'admin' });

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function createAccessToken(user, config) {
  return jwt.sign({ sub: String(user._id), role: user.role }, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN,
    issuer: 'invoice-risk-api',
    audience: 'invoice-risk-client'
  });
}

export function authenticate(config, UserModel = User) {
  return async (req, res, next) => {
    const [scheme, token] = (req.get('authorization') ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    let payload;
    try {
      payload = jwt.verify(token, config.JWT_SECRET, {
        issuer: 'invoice-risk-api', audience: 'invoice-risk-client'
      });
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    try {
      const user = await UserModel.findById(payload.sub);
      if (!user) return res.status(401).json({ error: 'Account is no longer available' });
      if (user.role !== payload.role) {
        return res.status(401).json({ code: 'ROLE_CHANGED', error: 'Your account role changed. Please sign in again.' });
      }
      req.auth = { userId: payload.sub, role: user.role };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required' });
    if (!allowedRoles.includes(req.auth.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    return next();
  };
}
