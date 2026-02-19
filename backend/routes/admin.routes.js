import express from "express";
import { v4 as uuidv4 } from "uuid";
import adminAuth from "../middleware/adminAuth.js";

export default function adminRoutes(pool) {
  const router = express.Router();

  /* =========================================
     Helper: Normalize QR Code
  ========================================= */
  function normalize(code) {
    return code?.trim().toUpperCase();
  }

  function isValidUUID(val) {
    return /^[0-9A-F-]{36}$/.test(val);
  }

  /* =========================================
     🔐 PROTECT ALL ROUTES BELOW
  ========================================= */
  router.use(adminAuth);

  /* =========================================
     1️⃣ GENERATE QR BATCH
  ========================================= */
  router.post("/generate-batch", async (req, res) => {
    const quantity = parseInt(req.body.quantity);

    if (!quantity || quantity < 1 || quantity > 5000) {
      return res.status(400).json({
        message: "Valid quantity required (1–5000)"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const codes = [];

      for (let i = 0; i < quantity; i++) {
        const qr_code = uuidv4().toUpperCase();

        await client.query(
          `
          INSERT INTO qr_tags 
          (qr_code, type, status, plan_type, price_paid)
          VALUES ($1, 'vehicle', 'inactive', 'yearly', 0)
          `,
          [qr_code]
        );

        codes.push(qr_code);
      }

      await client.query("COMMIT");

      return res.json({
        message: "Batch generated",
        count: quantity,
        codes
      });

    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      return res.status(500).json({ message: "Batch generation failed" });
    } finally {
      client.release();
    }
  });

  /* =========================================
     2️⃣ ACTIVATE / EXTEND SUBSCRIPTION
  ========================================= */
  router.post("/subscription/:code", async (req, res) => {
    const code = normalize(req.params.code);
    const years = parseInt(req.body.years);
    const price_paid = parseFloat(req.body.price_paid);

    if (!isValidUUID(code)) {
      return res.status(400).json({ message: "Invalid QR format" });
    }

    if (!years || years < 1) {
      return res.status(400).json({ message: "Valid years required" });
    }

    if (!price_paid || price_paid <= 0) {
      return res.status(400).json({ message: "Valid price_paid required" });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `
        UPDATE qr_tags
        SET 
          status = 'active',
          plan_type = 'yearly',
          subscription_started_at = COALESCE(subscription_started_at, NOW()),
          activated_at = COALESCE(activated_at, NOW()),
          price_paid = COALESCE(price_paid, 0) + $3,
          expires_at =
            CASE
              WHEN expires_at IS NULL OR expires_at < NOW()
              THEN NOW() + ($2 * INTERVAL '1 year')
              ELSE expires_at + ($2 * INTERVAL '1 year')
            END
        WHERE qr_code = $1
        RETURNING id, qr_code, status, activated_at, expires_at, price_paid
        `,
        [code, years, price_paid]
      );

      if (!result.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "QR not found" });
      }

      const qr = result.rows[0];

      await client.query(
        `
        INSERT INTO subscription_logs 
        (qr_tag_id, years_added, amount_paid)
        VALUES ($1, $2, $3)
        `,
        [qr.id, years, price_paid]
      );

      await client.query("COMMIT");

      return res.json({
        message: "Subscription updated",
        data: qr
      });

    } catch (error) {
      await client.query("ROLLBACK");
      console.error(error);
      return res.status(500).json({ message: "Server error" });
    } finally {
      client.release();
    }
  });

  /* =========================================
     3️⃣ LIST QR CODES (Paginated + total)
  ========================================= */
  router.get("/qrs", async (req, res) => {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    try {
      const [data, total] = await Promise.all([
        pool.query(
          `
          SELECT 
            q.qr_code,
            q.type,
            q.status,
            q.plan_type,
            q.price_paid,
            q.activated_at,
            q.expires_at,
            q.created_at,
            v.vehicle_number,
            v.owner_mobile
          FROM qr_tags q
          LEFT JOIN vehicle_profiles v
            ON q.id = v.qr_tag_id
          ORDER BY q.created_at DESC
          LIMIT $1 OFFSET $2
          `,
          [limit, offset]
        ),
        pool.query(`SELECT COUNT(*) FROM qr_tags`)
      ]);

      return res.json({
        page,
        total: parseInt(total.rows[0].count),
        data: data.rows
      });

    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: "Server error" });
    }
  });

  /* =========================================
     4️⃣ EXPIRED SUBSCRIPTIONS
  ========================================= */
  router.get("/expired", async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT qr_code, expires_at
        FROM qr_tags
        WHERE status = 'active'
          AND expires_at IS NOT NULL
          AND expires_at < NOW()
        ORDER BY expires_at ASC
        `
      );

      return res.json(result.rows);

    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: "Server error" });
    }
  });

  /* =========================================
     5️⃣ EMERGENCY LOGS
  ========================================= */
  router.get("/logs", async (req, res) => {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = 100;
    const offset = (page - 1) * limit;

    try {
      const result = await pool.query(
        `
        SELECT *
        FROM emergency_logs
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
        `,
        [limit, offset]
      );

      return res.json({
        page,
        count: result.rows.length,
        data: result.rows
      });

    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: "Server error" });
    }
  });

  /* =========================================
     6️⃣ DASHBOARD STATS (Corrected)
  ========================================= */
  router.get("/stats", async (req, res) => {
    try {
      const stats = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active') AS active,
          COUNT(*) FILTER (WHERE status = 'inactive') AS inactive,
          COUNT(*) FILTER (
            WHERE status = 'active'
            AND expires_at IS NOT NULL
            AND expires_at < NOW()
          ) AS expired,
          COUNT(*) AS total,
          COALESCE(SUM(price_paid), 0) AS total_revenue
        FROM qr_tags
      `);

      return res.json(stats.rows[0]);

    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error" });
    }
  });

  return router;
}