
module.exports = function (pool) {
  const express = require("express");
  const router = express.Router();

  function requireLogin(req, res, next) {
    if (!req.session.officer) {
      return res.status(401).json({
        error: "يجب تسجيل الدخول أولاً"
      });
    }

    next();
  }

  function requireText(value, maxLength) {
    return typeof value === "string" &&
      value.trim().length > 0 &&
      value.trim().length <= maxLength;
  }

  // عرض شبكة العلاقات
  router.get("/", requireLogin, async (req, res, next) => {
    try {
      const search = String(req.query.search || "").trim();

      const result = await pool.query(
        `SELECT
           r.id,
           r.person_one,
           r.person_two,
           r.relationship_type,
           r.notes,
           r.created_at,
           o.username AS created_by_username,
           o.full_name AS created_by_name
         FROM relationships r
         LEFT JOIN officers o ON o.id = r.created_by
         WHERE
           r.person_one ILIKE $1 OR
           r.person_two ILIKE $1 OR
           COALESCE(r.relationship_type, '') ILIKE $1 OR
           COALESCE(r.notes, '') ILIKE $1
         ORDER BY r.created_at DESC
         LIMIT 200`,
        [`%${search}%`]
      );

      res.json({
        success: true,
        relationships: result.rows
      });
    } catch (error) {
      next(error);
    }
  });

  // إضافة علاقة جديدة
  router.post("/", requireLogin, async (req, res, next) => {
    const {
      person_one,
      person_two,
      relationship_type,
      notes
    } = req.body;

    if (!requireText(person_one, 150)) {
      return res.status(400).json({
        error: "يرجى إدخال اسم الشخص الأول"
      });
    }

    if (!requireText(person_two, 150)) {
      return res.status(400).json({
        error: "يرجى إدخال اسم الشخص الثاني"
      });
    }

    if (person_one.trim().toLowerCase() ===
        person_two.trim().toLowerCase()) {
      return res.status(400).json({
        error: "لا يمكن ربط الشخص بنفسه"
      });
    }

    if (
      relationship_type !== undefined &&
      relationship_type !== null &&
      (typeof relationship_type !== "string" ||
       relationship_type.trim().length > 100)
    ) {
      return res.status(400).json({
        error: "نوع العلاقة غير صالح"
      });
    }

    if (
      notes !== undefined &&
      notes !== null &&
      (typeof notes !== "string" || notes.length > 5000)
    ) {
      return res.status(400).json({
        error: "الملاحظات طويلة أو غير صالحة"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `INSERT INTO relationships
          (person_one, person_two, relationship_type, notes, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          person_one.trim(),
          person_two.trim(),
          relationship_type ? relationship_type.trim() : null,
          notes ? notes.trim() : null,
          req.session.officer.id
        ]
      );

      const relationship = result.rows[0];

      await client.query(
        `INSERT INTO audit_logs
          (officer_id, action, details)
         VALUES ($1, $2, $3)`,
        [
          req.session.officer.id,
          "CREATE_RELATIONSHIP",
          `إضافة علاقة بين ${relationship.person_one} و${relationship.person_two}`
        ]
      );

      await client.query("COMMIT");

      res.status(201).json({
        success: true,
        message: "تمت إضافة العلاقة بنجاح",
        relationship
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  });

  // حذف علاقة
  router.delete("/:id", requireLogin, async (req, res, next) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT *
         FROM relationships
         WHERE id = $1
         FOR UPDATE`,
        [req.params.id]
      );

      if (result.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "العلاقة غير موجودة"
        });
      }

      const relationship = result.rows[0];
      const isAdmin =
        String(req.session.officer.role).toLowerCase() === "admin";

      if (
        !isAdmin &&
        String(relationship.created_by) !==
        String(req.session.officer.id)
      ) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          error: "لا تملك صلاحية حذف هذه العلاقة"
        });
      }

      await client.query(
        "DELETE FROM relationships WHERE id = $1",
        [req.params.id]
      );

      await client.query(
        `INSERT INTO audit_logs
          (officer_id, action, details)
         VALUES ($1, $2, $3)`,
        [
          req.session.officer.id,
          "DELETE_RELATIONSHIP",
          `حذف علاقة بين ${relationship.person_one} و${relationship.person_two}`
        ]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        message: "تم حذف العلاقة بنجاح"
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  });

  return router;
};
