import crypto from "crypto";

// ============================
// Secure OTP Generator (6 digit)
// ============================
export function generateOTP() {
  return crypto.randomInt(100000, 1000000).toString();
}

// ============================
// OTP Expiry (5 minutes)
// ============================
export function otpExpiry() {
  return new Date(Date.now() + 5 * 60 * 1000);
}