
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: false }
    : undefined
});

if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET) {
  throw new Error("DATABASE_URL and SESSION_SECRET are required");
}

// جلسات الضباط
app.use(session({
  name: "federal.sid",
  store: new PgSession({
    pool,
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

// التحقق من صلاحية المدير
function requireAdmin(req, res, next) {
  if (!req.session.officer) {
    return res.status(401).json({
      error: "يجب تسجيل الدخول أولاً"
    });
  }

  if (String(req.session.officer.role).toLowerCase() !== "admin") {
    return res.status(403).json({
      error: "ليست لديك صلاحية عرض سجل العمليات"
    });
  }

  next();
}

// تسجيل الدخول والخروج
const createAuthRouter = require("./routes/auth");
app.use("/api/auth", createAuthRouter(pool));

// إدارة العملاء
const createOfficersRouter = require("./routes/officers");
app.use("/api/officers", createOfficersRouter(pool));

// شبكة العلاقات
const createRelationshipsRouter = require("./routes/relationships");
app.use("/api/relationships", createRelationshipsRouter(pool));

// سجل العمليات - للمدير فقط
app.get("/api/audit-logs", requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         a.id,
         a.action,
         a.details,
         a.created_at,
         o.username AS admin_username,
         o.full_name AS admin_name
       FROM audit_logs a
       LEFT JOIN officers o ON o.id = a.officer_id
       ORDER BY a.created_at DESC
       LIMIT 100`
    );

    res.json({
      success: true,
      logs: result.rows
    });
  } catch (error) {
    next(error);
  }
});

// فحص الموقع وقاعدة البيانات
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      application: "FEDERAL BUREAU",
      status: "running",
      database: "connected"
    });
  } catch (error) {
    res.status(503).json({
      status: "error",
      database: "disconnected"
    });
  }
});

// ملفات الموقع
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((req, res) => {
  res.status(404).json({ error: "Page not found" });
});

app.use((error, req, res, next) => {
  console.error("Server error:", error.message);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(PORT, () => {
  console.log(`FEDERAL BUREAU running on port ${PORT}`);
});

process.on("SIGTERM", async () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});
