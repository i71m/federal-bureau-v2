
const express = require("express");
const bcrypt = require("bcrypt");

module.exports = function (pool) {
  const router = express.Router();

  // التحقق من حالة تسجيل الدخول
  router.get("/me", (req, res) => {
    if (!req.session.officer) {
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
  router.post("/login", async (req, res, next) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({
          error: "Username and password are required"
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
          error: "Invalid username or password"
        });
      }

      const officer = result.rows[0];

      if (!officer.active) {
        return res.status(403).json({
          error: "Account is disabled"
        });
      }

      const validPassword = await bcrypt.compare(
        password,
        officer.password_hash
      );

      if (!validPassword) {
        return res.status(401).json({
          error: "Invalid username or password"
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
        full_name: officer.full_name,
        rank: officer.rank,
        role: officer.role
      };

      await new Promise((resolve, reject) => {
        req.session.save((error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      res.json({
        success: true,
        officer: req.session.officer
      });

    } catch (error) {
      next(error);
    }
  });

  // تسجيل الخروج
  router.post("/logout", (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);

      res.clearCookie("federal.sid");
      res.json({ success: true });
    });
  });

  return router;
};
