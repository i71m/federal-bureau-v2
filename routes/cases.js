
const express = require("express");
const crypto = require("crypto");

module.exports = function (pool) {
  const router = express.Router();

  // التحقق من تسجيل الدخول
  function requireLogin(req, res, next) {
    if (!req.session || !req.session.officer) {
      return res.status(401).json({
        error: "يجب تسجيل الدخول أولاً"
      });
    }

    next();
  }

  // تسجيل العملية في سجل العمليات
  async function addAuditLog(db, officerId, action, details) {
    await db.query(
      `INSERT INTO audit_logs (officer_id, action, details)
       VALUES ($1, $2, $3)`,
      [officerId, action, details]
    );
  }

  // تسجيل الحدث في السجل التاريخي للقضية
  async function addCaseHistory(db, caseId, officerId, action, details) {
    await db.query(
      `INSERT INTO case_history
        (case_id, officer_id, action, details)
       VALUES ($1, $2, $3, $4)`,
      [caseId, officerId, action, details]
    );
  }

  // إنشاء رقم قضية تلقائي
  function generateCaseNumber() {
    const year = new Date().getFullYear();
    const code = crypto.randomBytes(3).toString("hex").toUpperCase();

    return `FB-${year}-${code}`;
  }

  // عرض جميع القضايا
  router.get("/", requireLogin, async (req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT
          c.*,
          assigned.full_name AS assigned_officer_name,
          creator.full_name AS creator_name
        FROM cases c
        LEFT JOIN officers assigned ON assigned.id = c.assigned_to
        LEFT JOIN officers creator ON creator.id = c.created_by
        ORDER BY c.created_at DESC
      `);

      res.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  // عرض قضية محددة
  router.get("/:id", requireLogin, async (req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT
          c.*,
          assigned.full_name AS assigned_officer_name,
          creator.full_name AS creator_name
        FROM cases c
        LEFT JOIN officers assigned ON assigned.id = c.assigned_to
        LEFT JOIN officers creator ON creator.id = c.created_by
        WHERE c.id = $1
      `, [req.params.id]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "القضية غير موجودة"
        });
      }

      res.json(result.rows[0]);
    } catch (error) {
      next(error);
    }
  });

  // إنشاء قضية جديدة
  router.post("/", requireLogin, async (req, res, next) => {
    const db = await pool.connect();

    try {
      const {
        title,
        description,
        status,
        priority,
        assigned_to
      } = req.body;

      if (typeof title !== "string" || !title.trim()) {
        return res.status(400).json({
          error: "عنوان القضية مطلوب"
        });
      }

      const assignedId =
        assigned_to === "" ||
        assigned_to === undefined ||
        assigned_to === null
          ? null
          : Number(assigned_to);

      if (
        assignedId !== null &&
        (!Number.isInteger(assignedId) || assignedId <= 0)
      ) {
        return res.status(400).json({
          error: "رقم الضابط المكلّف غير صحيح"
        });
      }

      if (assignedId !== null) {
        const officerCheck = await db.query(
          "SELECT id FROM officers WHERE id = $1 AND active = TRUE",
          [assignedId]
        );

        if (officerCheck.rows.length === 0) {
          return res.status(400).json({
            error: "الضابط المحدد غير موجود أو غير نشط"
          });
        }
      }

      await db.query("BEGIN");

      const caseNumber = generateCaseNumber();

      const result = await db.query(
        `INSERT INTO cases
          (case_number, title, description, status, priority, assigned_to, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          caseNumber,
          title.trim(),
          description || null,
          status || "Open",
          priority || "Normal",
          assignedId,
          req.session.officer.id
        ]
      );

      const newCase = result.rows[0];

      // تسجيل إنشاء القضية في السجل التاريخي
      await addCaseHistory(
        db,
        newCase.id,
        req.session.officer.id,
        "CREATE",
        {
          case_number: newCase.case_number,
          title: newCase.title,
          description: newCase.description,
          status: newCase.status,
          priority: newCase.priority,
          assigned_to: newCase.assigned_to
        }
      );

      await addAuditLog(
        db,
        req.session.officer.id,
        "CREATE_CASE",
        `تم إنشاء القضية ${newCase.case_number}: ${newCase.title}`
      );

      await db.query("COMMIT");

      res.status(201).json({
        success: true,
        message: "تم إنشاء القضية بنجاح",
        case: newCase
      });

    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      next(error);
    } finally {
      db.release();
    }
  });

  // تعديل قضية
  router.patch("/:id", requireLogin, async (req, res, next) => {
    const db = await pool.connect();

    try {
      const {
        title,
        description,
        status,
        priority,
        assigned_to
      } = req.body;

      const fields = [];
      const values = [];
      const changes = {};
      let index = 1;

      if (title !== undefined) {
        if (typeof title !== "string" || !title.trim()) {
          return res.status(400).json({
            error: "عنوان القضية لا يمكن أن يكون فارغاً"
          });
        }

        fields.push(`title = $${index++}`);
        values.push(title.trim());
      }

      if (description !== undefined) {
        fields.push(`description = $${index++}`);
        values.push(description || null);
      }

      if (status !== undefined) {
        fields.push(`status = $${index++}`);
        values.push(status);
      }

      if (priority !== undefined) {
        fields.push(`priority = $${index++}`);
        values.push(priority);
      }

      let assignedId;

      if (assigned_to !== undefined) {
        assignedId =
          assigned_to === "" || assigned_to === null
            ? null
            : Number(assigned_to);

        if (
          assignedId !== null &&
          (!Number.isInteger(assignedId) || assignedId <= 0)
        ) {
          return res.status(400).json({
            error: "رقم الضابط المكلّف غير صحيح"
          });
        }

        if (assignedId !== null) {
          const officerCheck = await db.query(
            "SELECT id FROM officers WHERE id = $1 AND active = TRUE",
            [assignedId]
          );

          if (officerCheck.rows.length === 0) {
            return res.status(400).json({
              error: "الضابط المحدد غير موجود أو غير نشط"
            });
          }
        }

        fields.push(`assigned_to = $${index++}`);
        values.push(assignedId);
      }

      if (fields.length === 0) {
        return res.status(400).json({
          error: "لا توجد بيانات لتعديلها"
        });
      }

      await db.query("BEGIN");

      // جلب البيانات القديمة قبل التعديل
      const oldResult = await db.query(
        "SELECT * FROM cases WHERE id = $1 FOR UPDATE",
        [req.params.id]
      );

      if (oldResult.rows.length === 0) {
        await db.query("ROLLBACK");

        return res.status(404).json({
          error: "القضية غير موجودة"
        });
      }

      const oldCase = oldResult.rows[0];

      values.push(req.params.id);

      const result = await db.query(
        `UPDATE cases
         SET ${fields.join(", ")}, updated_at = NOW()
         WHERE id = $${index}
         RETURNING *`,
        values
      );

      const updatedCase = result.rows[0];

      // مقارنة البيانات القديمة بالجديدة
      const fieldsToCompare = [
        "title",
        "description",
        "priority"
      ];

      fieldsToCompare.forEach(key => {
        if (oldCase[key] !== updatedCase[key]) {
          changes[key] = {
            before: oldCase[key],
            after: updatedCase[key]
          };
        }
      });

      // تسجيل التغييرات العامة
      if (Object.keys(changes).length > 0) {
        await addCaseHistory(
          db,
          updatedCase.id,
          req.session.officer.id,
          "UPDATE",
          changes
        );
      }

      // تسجيل تغيير الحالة
      if (oldCase.status !== updatedCase.status) {
        await addCaseHistory(
          db,
          updatedCase.id,
          req.session.officer.id,
          "STATUS_CHANGE",
          {
            before: oldCase.status,
            after: updatedCase.status
          }
        );
      }

      // تسجيل تغيير الضابط المكلّف
      if (String(oldCase.assigned_to ?? "") !== String(updatedCase.assigned_to ?? "")) {
        await addCaseHistory(
          db,
          updatedCase.id,
          req.session.officer.id,
          "ASSIGNMENT_CHANGE",
          {
            assigned_to: {
              before: oldCase.assigned_to,
              after: updatedCase.assigned_to
            }
          }
        );
      }

      await addAuditLog(
        db,
        req.session.officer.id,
        "UPDATE_CASE",
        `تم تعديل القضية ${updatedCase.case_number}`
      );

      await db.query("COMMIT");

      res.json({
        success: true,
        message: "تم تحديث القضية بنجاح",
        case: updatedCase
      });

    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      next(error);
    } finally {
      db.release();
    }
  });

  // حذف قضية
  // متاح لجميع الضباط المسجلين
  router.delete("/:id", requireLogin, async (req, res, next) => {
    try {
      const result = await pool.query(
        `DELETE FROM cases
         WHERE id = $1
         RETURNING id, case_number, title`,
        [req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "القضية غير موجودة"
        });
      }

      const deletedCase = result.rows[0];

      await addAuditLog(
        pool,
        req.session.officer.id,
        "DELETE_CASE",
        `تم حذف القضية ${deletedCase.case_number}: ${deletedCase.title}`
      );

      res.json({
        success: true,
        message: "تم حذف القضية بنجاح"
      });

    } catch (error) {
      if (error.code === "23503") {
        return res.status(409).json({
          error: "لا يمكن حذف القضية لوجود تقارير أو أدلة مرتبطة بها"
        });
      }

      next(error);
    }
  });

  return router;
};
