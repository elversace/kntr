const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');

const generateTokens = (user) => {
  const payload = {
    id: user.id,
    role: user.role,
    email: user.email,
    jti: uuidv4(),
  };

  const accessToken = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  });

  const refreshToken = jwt.sign(
    { id: user.id, type: 'refresh', jti: uuidv4() },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );

  return { accessToken, refreshToken };
};

const verifyToken = (token, secret = process.env.JWT_SECRET) => {
  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
};

const verifyRefreshToken = (token) => {
  return verifyToken(token, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
};

module.exports = { generateTokens, verifyToken, verifyRefreshToken };
