"""
PostgreSQL Migration Helper
Migrates data from SQLite to PostgreSQL (Neon or local)
"""
import os
import sys
import sqlite3
import psycopg2
from psycopg2.extras import execute_batch
from datetime import datetime

# Configuration
SQLITE_DB = os.getenv('SQLITE_DB', 'tactical.db')
POSTGRES_URL = os.getenv('DATABASE_URL', '')

# Tables to migrate
TABLES_TO_MIGRATE = [
    'matches',
    'predictions',
    'learning_log',
    'accuracy_log'
]

def connect_sqlite():
    """Connect to SQLite database"""
    try:
        conn = sqlite3.connect(SQLITE_DB)
        conn.row_factory = sqlite3.Row
        print(f"✅ Connected to SQLite: {SQLITE_DB}")
        return conn
    except Exception as e:
        print(f"❌ SQLite connection failed: {e}")
        return None

def connect_postgres():
    """Connect to PostgreSQL database"""
    if not POSTGRES_URL:
        print("❌ DATABASE_URL not set")
        return None
    
    try:
        conn = psycopg2.connect(POSTGRES_URL)
        print(f"✅ Connected to PostgreSQL")
        return conn
    except Exception as e:
        print(f"❌ PostgreSQL connection failed: {e}")
        return None

def get_table_schema(sqlite_conn, table_name):
    """Get table schema from SQLite"""
    try:
        cursor = sqlite_conn.cursor()
        cursor.execute(f"PRAGMA table_info({table_name})")
        columns = cursor.fetchall()
        return columns
    except Exception as e:
        print(f"⚠️  Could not get schema for {table_name}: {e}")
        return None

def migrate_table(sqlite_conn, pg_conn, table_name, batch_size=1000):
    """Migrate a single table from SQLite to PostgreSQL"""
    print(f"\n📦 Migrating table: {table_name}")
    
    try:
        # Get SQLite data
        sqlite_cursor = sqlite_conn.cursor()
        sqlite_cursor.execute(f"SELECT * FROM {table_name}")
        rows = sqlite_cursor.fetchall()
        
        if not rows:
            print(f"⚠️  No data in {table_name}")
            return True
        
        print(f"📊 Found {len(rows)} rows")
        
        # Get column names
        columns = [description[0] for description in sqlite_cursor.description]
        
        # Prepare PostgreSQL insert
        pg_cursor = pg_conn.cursor()
        
        # Build INSERT statement
        placeholders = ', '.join(['%s'] * len(columns))
        insert_query = f"""
            INSERT INTO {table_name} ({', '.join(columns)})
            VALUES ({placeholders})
            ON CONFLICT DO NOTHING
        """
        
        # Convert rows to tuples
        data = [tuple(row) for row in rows]
        
        # Batch insert
        execute_batch(pg_cursor, insert_query, data, page_size=batch_size)
        pg_conn.commit()
        
        print(f"✅ Migrated {len(rows)} rows to {table_name}")
        return True
        
    except Exception as e:
        print(f"❌ Migration failed for {table_name}: {e}")
        pg_conn.rollback()
        return False

def verify_migration(sqlite_conn, pg_conn, table_name):
    """Verify migration by comparing row counts"""
    try:
        # SQLite count
        sqlite_cursor = sqlite_conn.cursor()
        sqlite_cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
        sqlite_count = sqlite_cursor.fetchone()[0]
        
        # PostgreSQL count
        pg_cursor = pg_conn.cursor()
        pg_cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
        pg_count = pg_cursor.fetchone()[0]
        
        if sqlite_count == pg_count:
            print(f"✅ {table_name}: {sqlite_count} rows matched")
            return True
        else:
            print(f"⚠️  {table_name}: SQLite={sqlite_count}, PostgreSQL={pg_count}")
            return False
            
    except Exception as e:
        print(f"❌ Verification failed for {table_name}: {e}")
        return False

def main():
    print("="*60)
    print("PostgreSQL Migration Tool")
    print("="*60)
    print(f"SQLite DB: {SQLITE_DB}")
    print(f"PostgreSQL URL: {POSTGRES_URL[:50]}..." if POSTGRES_URL else "PostgreSQL URL: Not set")
    print("="*60)
    
    # Confirm
    if not POSTGRES_URL:
        print("\n❌ Error: DATABASE_URL environment variable not set")
        print("Set it with: export DATABASE_URL='postgresql://user:pass@host:5432/dbname'")
        sys.exit(1)
    
    response = input("\n⚠️  This will copy data from SQLite to PostgreSQL. Continue? (yes/no): ")
    if response.lower() != 'yes':
        print("❌ Migration cancelled")
        sys.exit(0)
    
    # Connect
    sqlite_conn = connect_sqlite()
    pg_conn = connect_postgres()
    
    if not sqlite_conn or not pg_conn:
        print("❌ Connection failed")
        sys.exit(1)
    
    # Migrate tables
    results = {}
    for table in TABLES_TO_MIGRATE:
        success = migrate_table(sqlite_conn, pg_conn, table)
        results[table] = success
    
    # Verify
    print("\n" + "="*60)
    print("VERIFICATION")
    print("="*60)
    
    for table in TABLES_TO_MIGRATE:
        if results[table]:
            verify_migration(sqlite_conn, pg_conn, table)
    
    # Summary
    print("\n" + "="*60)
    print("MIGRATION SUMMARY")
    print("="*60)
    
    successful = sum(1 for success in results.values() if success)
    total = len(results)
    
    print(f"✅ Successful: {successful}/{total}")
    print(f"❌ Failed: {total - successful}/{total}")
    
    # Cleanup
    sqlite_conn.close()
    pg_conn.close()
    
    if successful == total:
        print("\n🎉 Migration completed successfully!")
        print("\n📝 Next steps:")
        print("1. Verify data in PostgreSQL manually")
        print("2. Update .env to use DATABASE_URL")
        print("3. Test application with PostgreSQL")
        print("4. Backup SQLite file before switching")
    else:
        print("\n⚠️  Migration completed with errors")
        print("Check logs above for details")
    
    sys.exit(0 if successful == total else 1)

if __name__ == '__main__':
    main()
