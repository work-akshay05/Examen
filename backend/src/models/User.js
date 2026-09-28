import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['marketing', 'reviewer', 'admin'], default: 'marketing', required: true }
}, { timestamps: true, versionKey: false });

export const User = mongoose.model('User', userSchema);
