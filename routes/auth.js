
const express = require("express");
const bcrypt = require("bcrypt");

module.exports = function (pool) {
  const router = express.Router();

  // التحقق من الجلسة وحالة حساب الضابط
  async function requireActiveOfficer(req, res, next) {
    if (!req.session || !req.session.officer) {
      return res.status(401).json({
        success: false,
        authenticated: false,
        error: "يجب تسجيل الدخول أولاً."
      });
    }

    try {
      const result = await pool.query(
        `SELECT id, username, full_name, rank, role, active
         FROM officers
         WHERE id = $1
         LIMIT 1`,
        [req.session.officer.id]
      );

      if (
        result.rows.length === 0 ||
        !result.rows[0].active
      ) {
        return req.session.destroy((error) => {
          if (error) {
            console.error("Session destroy error:", error);
          }

          res.clearCookie("federal.sid");

          return res.status(401).json({
            success: false,
            authenticated: false,
            error: "تم إيقاف الحساب أو لم يعد موجوداً. يرجى تسجيل الدخول مجدداً."
          });
        });
      }

      const officer = result.rows[0];

      // تحديث بيانات الضابط في الجلسة
      req.session.officer = {
        id: officer.id,
        username: officer.username,
        fullName: officer.full_name,
        rank: officer.rank,
        role: officer.role
      };

      next();

    } catch (error) {
      console.error("Officer session check error:", error);

      return res.status(500).json({
        success: false,
        error: "تعذر التحقق من حساب الضابط."
      });
    }
  }

  // جلب بيانات الضابط المسجل
  router.get("/me", requireActiveOfficer, (req, res) => {
    return res.json({
      authenticated: true,
      officer: req.session.officer
    });
  });

  // تسجيل الدخول
  router.post("/login", async (req, res) => {
    try {
      const username = typeof req.body?.username === "string"
        ? req.body.username.trim()
        : "";

      const password = typeof req.body?.password === "string"
        ? req.body.password
        : "";

      if (!username || !password) {
        return res.status(400).json({
          success: false,
          error: "يرجى إدخال اسم المستخدم وكلمة المرور."
        });
      }

      if (username.length > 50 || password.length > 1024) {
        return res.status(400).json({
          success: false,
          error: "بيانات الدخول غير صالحة."
        });
      }

      const result = await pool.query(
        `SELECT id, username, password_hash,
                full_name, rank, role, active
         FROM officers
         WHERE LOWER(username) = LOWER($1)
         LIMIT 1`,
        [username]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          error: "بيانات الدخول غير صحيحة."
        });
      }

      const officer = result.rows[0];

      if (!officer.active) {
        return res.status(403).json({
          success: false,
          error: "الحساب موقوف."
        });
      }

      const validPassword = await bcrypt.compare(
        password,
        officer.password_hash
      );

      if (!validPassword) {
        return res.status(401).json({
          success: false,
          error: "بيانات الدخول غير صحيحة."
        });
      }

      await new Promise((resolve, reject) => {
        req.session.regenerate((error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      req.session.officer = {
        id: officer.id,
        username: officer.username,
        fullName: officer.full_name,
        rank: officer.rank,
        role: officer.role
      };

      await new Promise((resolve, reject) => {
        req.session.save((error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      return res.json({
        success: true,
        officer: req.session.officer
      });

    } catch (error) {
      console.error("Login error:", error);

      return res.status(500).json({
        success: false,
        error: "حدث خطأ أثناء تسجيل الدخول."
      });
    }
  });

  // تسجيل الخروج
  router.post("/logout", (req, res) => {
    if (!req.session) {
      return res.json({
        success: true
      });
    }

    req.session.destroy((error) => {
      if (error) {
        console.error("Logout error:", error);

        return res.status(500).json({
          success: false,
          error: "تعذر تسجيل الخروج."
        });
      }

      res.clearCookie("federal.sid");

      return res.json({
        success: true
      });
    });
  });

  return router;
};
