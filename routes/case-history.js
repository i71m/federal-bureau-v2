
module.exports = (pool) => {
    const express = require("express");
    const router = express.Router();

    // التحقق من تسجيل الدخول
    function requireLogin(req, res, next) {
        if (!req.session || !req.session.officer) {
            return res.status(401).json({
                error: "يجب تسجيل الدخول أولاً."
            });
        }

        next();
    }

    router.use(requireLogin);

    // التحقق من رقم القضية
    function validCaseId(caseId) {
        return /^\d+$/.test(caseId);
    }

    // عرض السجل التاريخي للقضية
    router.get("/:caseId", async (req, res) => {
        const { caseId } = req.params;

        if (!validCaseId(caseId)) {
            return res.status(400).json({
                error: "رقم القضية غير صالح."
            });
        }

        try {
            const result = await pool.query(
                `SELECT
                    ch.*,
                    o.username AS officer_username,
                    o.full_name AS officer_name,
                    o.rank AS officer_rank
                 FROM case_history ch
                 LEFT JOIN officers o ON o.id = ch.officer_id
                 WHERE ch.case_id = $1
                 ORDER BY ch.created_at DESC, ch.id DESC`,
                [caseId]
            );

            res.json({
                success: true,
                history: result.rows
            });

        } catch (error) {
            console.error("Case history error:", error);

            res.status(500).json({
                error: "تعذر تحميل سجل القضية."
            });
        }
    });

    // إضافة إجراء إلى السجل التاريخي
    router.post("/:caseId", async (req, res) => {
        const { caseId } = req.params;
        const { action, details } = req.body || {};
        const officerId = req.session.officer.id;

        if (!validCaseId(caseId)) {
            return res.status(400).json({
                error: "رقم القضية غير صالح."
            });
        }

        const allowedActions = [
            "NOTE",
            "UPDATE",
            "STATUS_CHANGE",
            "ASSIGNMENT_CHANGE",
            "REPORT_ADDED",
            "EVIDENCE_ADDED"
        ];

        if (!allowedActions.includes(action)) {
            return res.status(400).json({
                error: "نوع العملية غير صالح."
            });
        }

        if (
            typeof details !== "string" ||
            !details.trim() ||
            details.trim().length > 10000
        ) {
            return res.status(400).json({
                error: "يرجى كتابة التفاصيل، وبحد أقصى 10000 حرف."
            });
        }

        let client;

        try {
            client = await pool.connect();

            await client.query("BEGIN");

            // حفظ التفاصيل كنص JSON صالح داخل JSONB
            const jsonDetails = JSON.stringify(details.trim());

            const result = await client.query(
                `INSERT INTO case_history
                    (case_id, officer_id, action, details)
                 SELECT id, $2, $3, $4::JSONB
                 FROM cases
                 WHERE id = $1
                 RETURNING *`,
                [caseId, officerId, action, jsonDetails]
            );

            if (result.rows.length === 0) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    error: "القضية غير موجودة."
                });
            }

            await client.query(
                `INSERT INTO audit_logs
                    (officer_id, action, details)
                 VALUES ($1, $2, $3)`,
                [
                    officerId,
                    "CASE_HISTORY_ADDED",
                    `Case ID: ${caseId} | Action: ${action}`
                ]
            );

            await client.query("COMMIT");

            res.status(201).json({
                success: true,
                message: "تمت إضافة التحديث إلى سجل القضية.",
                history: result.rows[0]
            });

        } catch (error) {
            if (client) {
                await client.query("ROLLBACK").catch(() => {});
            }

            console.error("Add case history error:", error);

            res.status(500).json({
                error: "تعذرت إضافة التحديث."
            });

        } finally {
            if (client) {
                client.release();
            }
        }
    });

    // عرض ملاحظات القضية
    router.get("/notes/:caseId", async (req, res) => {
        const { caseId } = req.params;

        if (!validCaseId(caseId)) {
            return res.status(400).json({
                error: "رقم القضية غير صالح."
            });
        }

        try {
            const result = await pool.query(
                `SELECT
                    n.*,
                    o.username AS officer_username,
                    o.full_name AS officer_name,
                    o.rank AS officer_rank
                 FROM case_notes n
                 LEFT JOIN officers o ON o.id = n.officer_id
                 WHERE n.case_id = $1
                 ORDER BY n.created_at DESC, n.id DESC`,
                [caseId]
            );

            res.json({
                success: true,
                notes: result.rows
            });

        } catch (error) {
            console.error("Case notes error:", error);

            res.status(500).json({
                error: "تعذر تحميل ملاحظات القضية."
            });
        }
    });

    // إضافة ملاحظة للقضية
    router.post("/notes/:caseId", async (req, res) => {
        const { caseId } = req.params;

        const note = typeof req.body?.note === "string"
            ? req.body.note.trim()
            : "";

        if (!validCaseId(caseId)) {
            return res.status(400).json({
                error: "رقم القضية غير صالح."
            });
        }

        if (!note || note.length > 10000) {
            return res.status(400).json({
                error: "يرجى كتابة الملاحظة، وبحد أقصى 10000 حرف."
            });
        }

        let client;

        try {
            client = await pool.connect();

            await client.query("BEGIN");

            const result = await client.query(
                `INSERT INTO case_notes
                    (case_id, officer_id, note)
                 SELECT id, $2, $3
                 FROM cases
                 WHERE id = $1
                 RETURNING *`,
                [caseId, req.session.officer.id, note]
            );

            if (result.rows.length === 0) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    error: "القضية غير موجودة."
                });
            }

            await client.query(
                `INSERT INTO audit_logs
                    (officer_id, action, details)
                 VALUES ($1, $2, $3)`,
                [
                    req.session.officer.id,
                    "CASE_NOTE_ADDED",
                    `تمت إضافة ملاحظة للقضية رقم ${caseId}`
                ]
            );

            await client.query("COMMIT");

            res.status(201).json({
                success: true,
                message: "تم حفظ الملاحظة بنجاح.",
                note: result.rows[0]
            });

        } catch (error) {
            if (client) {
                await client.query("ROLLBACK").catch(() => {});
            }

            console.error("Add case note error:", error);

            res.status(500).json({
                error: "تعذرت إضافة الملاحظة."
            });

        } finally {
            if (client) {
                client.release();
            }
        }
    });

    return router;
};
