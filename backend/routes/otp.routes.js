import express from "express";
import rateLimit from "express-rate-limit";
import { generateOTP, otpExpiry } from "../services/otp.service.js";

export default function otpRoutes(pool) {
  const router = express.Router();

  /* =========================
     OTP Rate Limiter
  ========================= */
  const otpLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many OTP attempts. Try later." }
  });

  /* =========================
     SEND OTP
  ========================= */
  router.post("/send", otpLimiter, async (req, res) => {
    try {
      if (!req.body?.mobile) {
        return res.status(400).json({ message: "Mobile required" });
      }

      let mobile = req.body.mobile.trim();

      // Basic India mobile validation
      if (!/^[6-9]\d{9}$/.test(mobile)) {
        return res.status(400).json({ message: "Invalid mobile number" });
      }

      const otp = generateOTP();

      // Invalidate previous active OTPs
      await pool.query(
        `
        UPDATE otp_verifications
        SET verified = true
        WHERE mobile = $1
          AND verified = false
        `,
        [mobile]
      );

      // Insert new OTP
      await pool.query(
        `
        INSERT INTO otp_verifications
        (mobile, otp_code, expires_at, verified)
        VALUES ($1, $2, $3, false)
        `,
        [mobile, otp, otpExpiry()]
      );

      console.log("Generated OTP:", otp); // Remove when SMS integrated

      return res.status(200).json({
        message: "OTP sent successfully"
      });

    } catch (error) {
      console.error("OTP send error:", error);
      return res.status(500).json({ message: "Server error" });
    }
  });

  /* =========================
     VERIFY OTP
  ========================= */
  router.post("/verify", async (req, res) => {
    try {
      if (!req.body?.mobile || !req.body?.otp) {
        return res.status(400).json({
          message: "mobile and otp required"
        });
      }

      let mobile = req.body.mobile.trim();
      let otp = req.body.otp.trim();

      const result = await pool.query(
        `
        SELECT id
        FROM otp_verifications
        WHERE mobile = $1
          AND otp_code = $2
          AND expires_at > NOW()
          AND verified = false
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [mobile, otp]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({
          message: "Invalid or expired OTP"
        });
      }

      // Mark matched OTP as verified
      await pool.query(
        `
        UPDATE otp_verifications
        SET verified = true
        WHERE id = $1
        `,
        [result.rows[0].id]
      );

      return res.status(200).json({
        message: "OTP verified successfully"
      });

    } catch (error) {
      console.error("OTP verify error:", error);
      return res.status(500).json({ message: "Server error" });
    }
  });

  return router;
}