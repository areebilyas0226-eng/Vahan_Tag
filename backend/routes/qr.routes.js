import express from "express";

export default function qrRoutes(pool) {
  const router = express.Router();

  const ALLOWED_CONTACT_ACTIONS = ["sms", "call"];

  /* =========================
     Helper: Real Client IP
  ========================= */
  function getClientIP(req) {
    return (
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      req.ip ||
      "unknown"
    );
  }

  /* =========================
     Normalize QR Code
  ========================= */
  function normalize(code) {
    return code?.trim().toUpperCase() || null;
  }

  /* =========================
     Test Route
  ========================= */
  router.get("/test", (req, res) => {
    return res.json({ message: "QR route working" });
  });

  /* =========================
     Create QR (Internal use)
  ========================= */
  router.post("/", async (req, res) => {
    let { qr_code, type } = req.body;

    if (!qr_code || !type)
      return res.status(400).json({
        message: "qr_code and type required"
      });

    qr_code = normalize(qr_code);

    try {
      const result = await pool.query(
        `
        INSERT INTO qr_tags (qr_code, type, status)
        VALUES ($1, $2, 'inactive')
        RETURNING id, qr_code, type, status
        `,
        [qr_code, type]
      );

      return res.status(201).json({
        message: "QR created",
        data: result.rows[0]
      });

    } catch (err) {
      if (err.code === "23505") {
        return res.status(400).json({ message: "QR already exists" });
      }

      console.error("Create QR error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  });

  /* =========================
     Get QR (Validated + Auto Log)
  ========================= */
  router.get("/:code", async (req, res) => {
    const code = normalize(req.params.code);

    if (!code)
      return res.status(400).json({ message: "Invalid QR code" });

    try {
      const result = await pool.query(
        `
        SELECT 
          q.id,
          q.qr_code,
          q.type,
          q.status,
          q.activated_at,
          q.expires_at,
          v.vehicle_number,
          v.owner_mobile,
          v.blood_group,
          v.model
        FROM qr_tags q
        LEFT JOIN vehicle_profiles v
          ON q.id = v.qr_tag_id
        WHERE q.qr_code = $1
          AND q.status = 'active'
          AND (q.expires_at IS NULL OR q.expires_at > NOW())
        `,
        [code]
      );

      if (!result.rows.length)
        return res.status(403).json({
          message: "QR invalid, inactive, or expired"
        });

      const qr = result.rows[0];

      // Non-blocking view log
      pool.query(
        `
        INSERT INTO emergency_logs (qr_tag_id, action_type, caller_ip)
        VALUES ($1, 'view', $2)
        `,
        [qr.id, getClientIP(req)]
      ).catch(console.error);

      return res.json(qr);

    } catch (err) {
      console.error("Fetch QR error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  });

  /* =========================
     Contact Owner (Spam Protected)
  ========================= */
  router.post("/:code/contact", async (req, res) => {
    const code = normalize(req.params.code);
    const { action_type } = req.body;

    if (!code)
      return res.status(400).json({ message: "Invalid QR code" });

    if (!ALLOWED_CONTACT_ACTIONS.includes(action_type))
      return res.status(400).json({
        message: "Invalid action_type"
      });

    try {
      const qrResult = await pool.query(
        `
        SELECT id
        FROM qr_tags
        WHERE qr_code = $1
          AND status = 'active'
          AND (expires_at IS NULL OR expires_at > NOW())
        `,
        [code]
      );

      if (!qrResult.rows.length)
        return res.status(403).json({
          message: "QR invalid, inactive, or expired"
        });

      const qrId = qrResult.rows[0].id;
      const ip = getClientIP(req);

      // Strict rate limiting (5 per 2 minutes per IP)
      const spamCheck = await pool.query(
        `
        SELECT COUNT(*)
        FROM emergency_logs
        WHERE caller_ip = $1
          AND created_at > NOW() - INTERVAL '2 minutes'
        `,
        [ip]
      );

      if (Number(spamCheck.rows[0].count) >= 5)
        return res.status(429).json({
          message: "Too many requests"
        });

      await pool.query(
        `
        INSERT INTO emergency_logs (qr_tag_id, action_type, caller_ip)
        VALUES ($1, $2, $3)
        `,
        [qrId, action_type, ip]
      );

      return res.json({ message: "Contact logged" });

    } catch (err) {
      console.error("Contact error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  });

  return router;
}