/* eslint-disable */
const { neon } = require('@neondatabase/serverless');
const sql = neon('postgresql://neondb_owner:npg_qwZ49BYycWTX@ep-dry-mouse-apf9dz1j.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require');

async function check() {
  const res = await sql`SELECT * FROM transfers ORDER BY created_at DESC LIMIT 1;`;
  console.log(res);
}
check().catch(console.error);
