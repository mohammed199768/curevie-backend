const pool = require('../../config/db');
const { logger } = require('../logger');
const {
  generateMedicalReportPdf,
  generateMedicalReportPdfFromSnapshot,
} = require('./medical-report.generator');
const { storeGeneratedPdf } = require('./storage');
const RequestRepository = require('../../repositories/RequestRepository');

const PDF_RETRY_INTERVAL_MS = 300000;
const requestRepo = new RequestRepository(pool);

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
      SELECT id, request_id, report_snapshot, pdf_generation_attempts
      FROM medical_reports
      WHERE status = 'PUBLISHED'
        AND pdf_url IS NULL
        AND pdf_generation_attempts < 3
      ORDER BY updated_at ASC NULLS FIRST, id ASC
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
        RETURNING request_id, report_snapshot, pdf_generation_attempts
        `,
        [row.id]
      );

      const reservedRow = reservedResult.rows[0];
      if (!reservedRow) {
        continue;
      }

      const requestId = reservedRow.request_id;
      const snapshot = reservedRow.report_snapshot;
      const attempt = reservedRow.pdf_generation_attempts;

      try {
        const pdfBuffer = snapshot
          ? await generateMedicalReportPdfFromSnapshot(snapshot)
          : await generateMedicalReportPdf(requestId);

        const pdfUrl = await storeGeneratedPdf(
          pdfBuffer,
          `medical-report-${requestId}.pdf`,
          'medical-reports'
        );

        if (!pdfUrl) {
          throw new Error('PDF storage returned an empty URL');
        }

        await requestRepo.updateMedicalReportPdfUrl(requestId, pdfUrl);
        succeeded += 1;

        logger.info('PDF retry job generated medical report successfully', {
          requestId,
          attempt,
          pdfUrl,
        });
      } catch (error) {
        logger.warn('PDF retry job failed to generate medical report', {
          requestId,
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
