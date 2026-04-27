import Database from 'better-sqlite3';
const db = new Database('placement_prep.sqlite');
try {
  db.exec(`
    PRAGMA foreign_keys=off;
    CREATE TABLE new_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('student', 'expert', 'college_admin')),
      expertise TEXT, 
      bio TEXT,
      resume_url TEXT,
      photo_url TEXT,
      college TEXT,
      city TEXT,
      state TEXT,
      github_url TEXT,
      linkedin_url TEXT,
      skills TEXT,
      grad_year TEXT,
      company TEXT,
      years_of_experience TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO new_users (id, email, password, name, role, expertise, bio, resume_url, photo_url, college, city, state, github_url, linkedin_url, skills, grad_year, company, years_of_experience, created_at)
    SELECT id, email, password, name, role, expertise, bio, resume_url, photo_url, college, city, state, github_url, linkedin_url, skills, grad_year, company, years_of_experience, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE new_users RENAME TO users;
    PRAGMA foreign_keys=on;
  `);
  console.log('Database fixed successfully');
} catch(e) {
  console.error('Error fixing database:', e);
}
