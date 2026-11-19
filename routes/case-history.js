
module.exports = (pool) => {
    const express = require("express");
    const router = express.Router();

    function requireLogin(req, res, next) {
        if (!req.session || !req.session.officer) {
            return res.status(401).json({
                error: "يجب تسجيل الدخول أولاً."
            });
        }

        next();
    }

    router.use(requireLogin);

    // عرض السجل التاريخي لقضية
    router.get("/:caseId", async (req, res) => {
        const { caseId } = req.params;

        if (!/^\d+$/.test(caseId)) {
            return res.status(400).json({
                error: "رقم القضية غير صالح."
            });
        }

        try {
            const caseResult = await pool.query(
                "SELECT id FROM cases WHERE id = $1",
                [caseId]
            );

            if (!caseResult.rows.length) {
                return res.status(404).json({
                    error: "القضية غير موجودة."
                });
            }

            const result = await pool.query(
                `SELECT
                    ch.id,
                    ch.case_id,
                    ch.action,
                    ch.details,
                    ch.created_at,
                    o.id AS officer_id,
                    o.username AS officer_username,
                    o.full_name AS officer_name,
                    o.rank AS officer_rank
                 FROM case_history ch
                 LEFT JOIN officers o ON o.id = ch.officer_id
                 WHERE ch.case_id = $1
                 ORDER BY ch.created_at DESC, ch.id DESC`,
                [caseId]
            );

            res.json(result.rows);
        } catch (error) {
            console.error("Case history error:", error);

            res.status(500).json({
                error: "تعذر تحميل سجل القضية."
            });
        }
    });

    // إضافة ملاحظة أو تحديث إلى سجل القضية
    router.post("/:caseId", async (req, res) => {
        const { caseId } = req.params;
        const { action, details } = req.body;
        const officerId = req.session.officer.id;

        if (!/^\d+$/.test(caseId)) {
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

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const caseResult = await client.query(
                "SELECT id FROM cases WHERE id = $1 FOR UPDATE",
                [caseId]
            );

            if (!caseResult.rows.length) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    error: "القضية غير موجودة."
                });
            }

            const result = await client.query(
                `INSERT INTO case_history
                    (case_id, officer_id, action, details)
                 VALUES ($1, $2, $3, $4)
                 RETURNING *`,
                [caseId, officerId, action, details.trim()]
            );

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
                message: "تمت إضافة التحديث إلى سجل القضية.",
                history: result.rows[0]
            });
        } catch (error) {
            await client.query("ROLLBACK");

            console.error("Add case history error:", error);

            res.status(500).json({
                error: "تعذرت إضافة التحديث."
            });
        } finally {
            client.release();
        }
    });

    return router;
};
