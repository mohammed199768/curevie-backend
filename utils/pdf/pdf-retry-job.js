const pool = require('../../config/db');
const { logger } = require('../logger');

const PDF_RETRY_INTERVAL_MS = 300000;

let retryIntervalId = null;
let tickInProgress = false;

async function runPdfRetryTick() {
  if (tickInProgress) {
    logger.warn('PDF retry job tick skipped because a previous tick is still running');
    return;
  }

  tickInProgress = true;

  try {
    const pendingResult = await pool.query(
      `
      SELECT id, case_id, pdf_generation_attempts
      FROM medical_reports
      WHERE status = 'PUBLISHED'
        AND pdf_url IS NULL
        AND pdf_generation_attempts < 3
      ORDER BY updated_at ASC NULLS FIRST
      `
    );

    const rows = pendingResult.rows;
    let succeeded = 0;

    for (const row of rows) {
      const reservedResult = await pool.query(
        `
        UPDATE medical_reports
        SET pdf_generation_attempts = COALESCE(pdf_generation_attempts, 0) + 1,
            pdf_last_failed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND status = 'PUBLISHED'
          AND pdf_url IS NULL
          AND pdf_generation_attempts < 3
        RETURNING case_id, pdf_generation_attempts
        `,
        [row.id]
      );

      const reservedRow = reservedResult.rows[0];
      if (!reservedRow) {
        continue;
      }

      const caseId = reservedRow.case_id;
      const attempt = reservedRow.pdf_generation_attempts;

      try {
        const { generateCaseReportPdf } = require('./case-report.generator');

        const pdfUrl = await generateCaseReportPdf(caseId);

        if (!pdfUrl) {
          throw new Error('generateCaseReportPdf returned empty URL');
        }

        await pool.query(
          `UPDATE medical_reports
           SET pdf_url = $1,
               status = 'PUBLISHED',
               published_at = NOW(),
               updated_at = NOW()
           WHERE case_id = $2`,
          [pdfUrl, caseId]
        );

        succeeded += 1;
        logger.info('PDF retry job generated case report successfully', {
          caseId,
          attempt,
          pdfUrl,
        });
      } catch (error) {
        logger.warn('PDF retry job failed to generate case report', {
          caseId,
          attempt,
          error: error.message,
        });
      }
    }

    logger.info('PDF retry job tick completed', {
      found: rows.length,
      succeeded,
    });
  } catch (error) {
    logger.warn('PDF retry job tick failed', {
      error: error.message,
    });
  } finally {
    tickInProgress = false;
  }
}

function startPdfRetryJob() {
  if (retryIntervalId) {
    return retryIntervalId;
  }

  logger.info('Starting PDF retry job', {
    intervalMs: PDF_RETRY_INTERVAL_MS,
  });

  retryIntervalId = setInterval(() => {
    void runPdfRetryTick();
  }, PDF_RETRY_INTERVAL_MS);

  return retryIntervalId;
}

module.exports = {
  startPdfRetryJob,
};
