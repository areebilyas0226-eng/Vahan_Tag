import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";

import pool from "./db.js";
import qrRoutes from "./routes/qr.routes.js";
import emergencyRoutes from "./routes/emergency.routes.js";
import otpRoutes from "./routes/otp.routes.js";
import maskedRoutes from "./routes/masked.routes.js";
import adminRoutes from "./routes/admin.routes.js";

dotenv.config();

const app = express();

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 5000;

console.log("Environment PORT:", process.env.PORT);
console.log("Server will run on:", PORT);

/* =========================
   TRUST PROXY
========================= */
app.set("trust proxy", 1);

/* =========================
   CORS
========================= */
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://your-frontend-domain.com"
    ],
    credentials: true
  })
);

/* =========================
   BODY PARSER
========================= */
app.use(express.json({ limit: "10kb" }));

/* =========================
   RATE LIMITING
========================= */
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(globalLimiter);

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30
});

/* =========================
   ROUTES
========================= */
app.use("/api/qr", qrRoutes(pool));
app.use("/api/emergency", emergencyRoutes(pool));
app.use("/api/otp", otpRoutes(pool));
app.use("/api/masked", maskedRoutes(pool));
app.use("/api/admin", adminLimiter, adminRoutes(pool));

/* =========================
   ROOT
========================= */
app.get("/", (req, res) => {
  res.status(200).json({ message: "API running" });
});

/* =========================
   HEALTH CHECK (CRITICAL FOR RAILWAY)
========================= */
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

/* =========================
   404
========================= */
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

/* =========================
   GLOBAL ERROR HANDLER
========================= */
app.use((err, req, res, next) => {
  console.error("Unhandled Error:", err);
  res.status(500).json({ error: "Internal server error" });
});

/* =========================
   START SERVER
========================= */
const server = app.listen(PORT, "0.0.0.0",  () => {
  console.log(`Server running on port ${PORT}`);
});

/* =========================
   GRACEFUL SHUTDOWN
========================= */
process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down gracefully...");
  server.close(() => {
    pool.end().then(() => {
      console.log("Database pool closed.");
      process.exit(0);
    });
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT received. Exiting...");
  process.exit(0);
});