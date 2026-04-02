require('dotenv').config();
const pool = require('./config/db');
async function run() {
  const recentResults = await pool.query(`
    SELECT r.id, r.request_id, lt.name as test_name, r.result, r.is_normal, r.flag, r.created_at
    FROM lab_test_results r
    JOIN lab_tests lt ON lt.id = r.lab_test_id
    ORDER BY r.created_at DESC LIMIT 5;
  `);
  const fs = require('fs');
  const output = {
    RECENT_RESULTS: recentResults.rows
  };

  if (recentResults.rows.length > 0) {
    const testName = recentResults.rows[0].test_name;
    const ranges = await pool.query(`
      SELECT * FROM lab_test_reference_ranges 
      WHERE lab_test_id = (SELECT id FROM lab_tests WHERE name = $1 LIMIT 1);
    `, [testName]);
    output[`RANGES_FOR_${testName}`] = ranges.rows;
    
    const parentReqId = recentResults.rows[0].request_id;
    const reqInfo = await pool.query(`
      SELECT sr.id, p.id as patient_id, p.date_of_birth, p.gender 
      FROM service_requests sr 
      LEFT JOIN patients p ON p.id = sr.patient_id 
      WHERE sr.id = $1;
    `, [parentReqId]);
    output['REQUEST_PATIENT'] = reqInfo.rows;
  }
  
  fs.writeFileSync('output.json', JSON.stringify(output, null, 2));
  pool.end();
}
run().catch(console.error);
