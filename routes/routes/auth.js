const express = require("express");
const bcrypt = require("bcrypt");

module.exports = function (pool) {
  const router = express.Router();

  // جلب بيانات الضابط المسجل
  router.get("/me", (req, res) => {
    if (!req.session || !req.session.officer) {
      return res.status(401).json({
        authenticated: false
      });
    }

    res.json({
      authenticated: true,
      officer: req.session.officer
    });
  });

  // تسجيل الدخول
  router.post("/login", async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({
          error: "يرجى إدخال اسم المستخدم وكلمة المرور"
        });
      }

      const result = await pool.query(
        `SELECT id, username, password_hash,
                full_name, rank, role, active
         FROM officers
         WHERE LOWER(username) = LOWER($1)
         LIMIT 1`,
        [username.trim()]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          error: "بيانات الدخول غير صحيحة"
        });
      }

      const officer = result.rows[0];

      if (!officer.active) {
        return res.status(403).json({
          error: "الحساب موقوف"
        });
      }

      const valid = await bcrypt.compare(
        password,
        officer.password_hash
      );

      if (!valid) {
        return res.status(401).json({
          error: "بيانات الدخول غير صحيحة"
        });
      }

      req.session.regenerate((error) => {
        if (error) {
          return res.status(500).json({
            error: "تعذر إنشاء جلسة الدخول"
          });
        }

        req.session.officer = {
          id: officer.id,
          username: officer.username,
          fullName: officer.full_name,
          rank: officer.rank,
          role: officer.role
        };

        req.session.save((error) => {
          if (error) {
            return res.status(500).json({
              error: "تعذر حفظ جلسة الدخول"
            });
          }

          res.json({
            success: true,
            officer: req.session.officer
          });
        });
      });

    } catch (error) {
      console.error("Login error:", error.message);

      res.status(500).json({
        error: "حدث خطأ أثناء تسجيل الدخول"
      });
    }
  });

  // تسجيل الخروج
  router.post("/logout", (req, res) => {
    if (!req.session) {
      return res.json({ success: true });
    }

    req.session.destroy((error) => {
      if (error) {
        return res.status(500).json({
          error: "تعذر تسجيل الخروج"
        });
      }

      res.clearCookie("federal.sid");

      res.json({
        success: true
      });
    });
  });

  return router;
};
