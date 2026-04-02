const pool = require('./config/db');

async function checkSchema() {
  try {
    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name IN ('packages', 'package_tests', 'service_requests', 'invoices', 'services', 'lab_tests')
    `);

    for (const table of tables.rows) {
      console.log(`\n=== Table: ${table.table_name} ===`);
      
      const columns = await pool.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
      `, [table.table_name]);
      
      console.log("Columns:");
      columns.rows.forEach(col => console.log(`  - ${col.column_name} (${col.data_type}, nullable: ${col.is_nullable})`));

      const constraints = await pool.query(`
        SELECT
            tc.constraint_name, 
            tc.constraint_type,
            kcu.column_name, 
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name,
            pg_get_constraintdef(c.oid) as check_clause
        FROM 
            information_schema.table_constraints AS tc 
            JOIN information_schema.key_column_usage AS kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            LEFT JOIN information_schema.constraint_column_usage AS ccu
              ON ccu.constraint_name = tc.constraint_name
              AND ccu.table_schema = tc.table_schema
            JOIN pg_constraint c ON c.conname = tc.constraint_name
        WHERE tc.table_schema = 'public' AND tc.table_name = $1
      `, [table.table_name]);

      console.log("Constraints:");
      constraints.rows.forEach(con => {
        let details = '';
        if (con.constraint_type === 'FOREIGN KEY') {
          details = ` -> ${con.foreign_table_name}(${con.foreign_column_name})`;
        } else if (con.constraint_type === 'CHECK') {
          details = ` (${con.check_clause})`;
        }
        console.log(`  - ${con.constraint_name} (${con.constraint_type}) on ${con.column_name}${details}`);
      });
    }

    const types = await pool.query(`
      SELECT t.typname, e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE t.typname IN ('service_type', 'provider_type', 'request_status', 'workflow_task_type')
      ORDER BY t.typname, e.enumsortorder
    `);
    
    console.log("\n=== ENUMS ===");
    const groupedTypes = types.rows.reduce((acc, row) => {
      acc[row.typname] = acc[row.typname] || [];
      acc[row.typname].push(row.enumlabel);
      return acc;
    }, {});
    
    for (const [typname, labels] of Object.entries(groupedTypes)) {
      console.log(`${typname}: ${labels.join(', ')}`);
    }

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

checkSchema();
