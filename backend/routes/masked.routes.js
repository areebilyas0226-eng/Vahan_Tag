import express from "express";

export default function maskedRoutes(pool) {
  const router = express.Router();

  // Initiate masked call
  router.post("/:code/call", async (req, res) => {
    const { code } = req.params;

    try {
      // 1. Get QR
      const qrResult = await pool.query(
        `SELECT id, status, expires_at
         FROM qr_tags
         WHERE qr_code = $1`,
        [code]
      );

      if (qrResult.rows.length === 0) {
        return res.status(404).json({ message: "QR not found" });
      }

      const qr = qrResult.rows[0];

      if (qr.status !== "active") {
        return res.status(403).json({ message: "QR not active" });
      }

      // 2. Get owner number
      const profileResult = await pool.query(
        `SELECT owner_mobile
         FROM vehicle_profiles
         WHERE qr_tag_id = $1`,
        [qr.id]
      );

      if (profileResult.rows.length === 0) {
        return res.status(404).json({ message: "Profile not found" });
      }

      const ownerMobile = profileResult.rows[0].owner_mobile;

      // 3. Save masked call request (provider integration later)
      const callInsert = await pool.query(
        `INSERT INTO masked_calls (qr_tag_id, caller_number, status)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [qr.id, req.ip, "initiated"]
      );

      return res.json({
        message: "Masked call initiated",
        owner: ownerMobile,
        call_id: callInsert.rows[0].id
      });

    } catch (error) {
      console.error("Masked call error:", error);
      return res.status(500).json({ message: "Server error" });
    }
  });

  return router;
}