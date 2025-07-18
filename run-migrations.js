import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function runMigrations() {
  console.log('🚀 Running database migrations...\n');

  const migrationsDir = path.join(__dirname, 'supabase', 'migrations');
  const files = fs.readdirSync(migrationsDir).sort();

  for (const file of files) {
    if (!file.endsWith('.sql')) continue;

    console.log(`📄 Running migration: ${file}`);
    
    try {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      
      // Split by semicolons but be careful about functions
      const statements = sql
        .split(/;(?=\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|--|\n|$))/i)
        .map(s => s.trim())
        .filter(s => s.length > 0);

      for (const statement of statements) {
        if (statement.trim()) {
          const { error } = await supabase.rpc('exec_sql', {
            sql: statement + ';'
          }).catch(async (e) => {
            // If exec_sql doesn't exist, try direct query
            const { error } = await supabase.from('_migrations').select('*').limit(0);
            if (error?.message?.includes('_migrations')) {
              // Table doesn't exist, we need to use SQL editor approach
              console.error(`  ⚠️  Cannot run SQL directly. Please run this migration manually in Supabase SQL editor.`);
              console.log(`  📋 SQL to run:\n${statement}\n`);
              return { error: { message: 'Manual migration required' } };
            }
            return { error: e };
          });

          if (error) {
            console.error(`  ❌ Error: ${error.message}`);
            if (error.message === 'Manual migration required') {
              continue;
            }
            throw error;
          }
        }
      }
      
      console.log(`  ✅ Success!\n`);
    } catch (error) {
      console.error(`  ❌ Failed to run ${file}:`, error.message);
      console.log(`  💡 You may need to run this migration manually in the Supabase SQL editor\n`);
    }
  }

  console.log('✨ Migration process complete!');
  console.log('\n📝 Note: Some migrations may need to be run manually in the Supabase SQL editor.');
  console.log('Visit: https://supabase.com/dashboard/project/zsuulzczbhgrfjtocwfy/sql/new\n');
}

runMigrations().catch(console.error);