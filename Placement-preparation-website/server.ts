import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use a local SQLite database instead of Postgres so it runs locally without DB setup
const db = new Database(path.join(__dirname, "placement_prep.sqlite"));

// Shim layer to convert postgres query style to sqlite
const pool = {
  query: async (sql: string, params: any[] = []) => {
    let sqliteSql = sql.replace(/\$\d+/g, '?');
    sqliteSql = sqliteSql.replace(/SERIAL PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT');

    if (sqliteSql.includes('current_database()')) {
      return { rows: [{ current_database: 'sqlite_local' }] };
    }
    if (sqliteSql.includes('users_id_seq')) {
      return { rows: [{ last_value: 0, is_called: false }] };
    }

    let isReturningId = false;
    if (sqliteSql.match(/RETURNING\s+id/i)) {
      sqliteSql = sqliteSql.replace(/RETURNING\s+id/i, '');
      isReturningId = true;
    }

    try {
      const isSelect = sqliteSql.trim().toUpperCase().startsWith('SELECT') || 
                       sqliteSql.trim().toUpperCase().startsWith('WITH');
      if (isSelect) {
        const stmt = db.prepare(sqliteSql);
        const rows = stmt.all(...params);
        return { rows };
      } else {
        if (sqliteSql.includes(';') && params.length === 0) {
          db.exec(sqliteSql);
          return { rows: [] };
        } else {
          const stmt = db.prepare(sqliteSql);
          const info = stmt.run(...params);
          if (isReturningId) {
            return { rows: [{ id: info.lastInsertRowid }] };
          }
          return { rows: [] };
        }
      }
    } catch (e: any) {
      console.error("SQLite error:", e.message, "\\nSQL:", sqliteSql);
      throw e;
    }
  },
  connect: async () => {
    return {
      query: async (sql: string, params: any[] = []) => pool.query(sql, params),
      release: () => { }
    };
  }
};

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
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

    CREATE TABLE IF NOT EXISTS aptitude_scores (
      id SERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      section TEXT NOT NULL, 
      score INTEGER NOT NULL,
      total INTEGER NOT NULL,
      is_mock BOOLEAN DEFAULT false,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS availability (
      id SERIAL PRIMARY KEY,
      expert_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      start_time TIMESTAMP NOT NULL,
      end_time TIMESTAMP NOT NULL,
      status TEXT DEFAULT 'available' CHECK (status IN ('available', 'booked'))
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      expert_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role TEXT,
      start_time TIMESTAMP NOT NULL,
      end_time TIMESTAMP NOT NULL,
      meet_link TEXT,
      status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
      rating INTEGER CHECK (rating >= 1 AND rating <= 5),
      feedback TEXT,
      expert_joined BOOLEAN DEFAULT false
    );

    -- Performance indexes
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_aptitude_student ON aptitude_scores(student_id);
    CREATE INDEX IF NOT EXISTS idx_availability_expert ON availability(expert_id);
    CREATE INDEX IF NOT EXISTS idx_availability_status ON availability(status);
    CREATE INDEX IF NOT EXISTS idx_bookings_student ON bookings(student_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_expert ON bookings(expert_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

    CREATE TABLE IF NOT EXISTS selection_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      target_roles TEXT NOT NULL,
      status TEXT DEFAULT 'preparing' CHECK (status IN ('preparing', 'ready', 'in_progress', 'completed')),
      test_schema TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS round_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER REFERENCES selection_rounds(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      uid TEXT NOT NULL,
      branch TEXT NOT NULL,
      status TEXT DEFAULT 'waiting' CHECK (status IN ('waiting', 'testing', 'completed', 'selected')),
      score INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      score_details TEXT,
      fit_tags TEXT
    );
  `);

  // Add columns that might be missing from older schema versions
  const alterQueries = [
    "ALTER TABLE aptitude_scores ADD COLUMN IF NOT EXISTS is_mock BOOLEAN DEFAULT false",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS company TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS years_of_experience TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
    "ALTER TABLE round_participants ADD COLUMN IF NOT EXISTS score_details TEXT",
    "ALTER TABLE round_participants ADD COLUMN IF NOT EXISTS fit_tags TEXT"
  ];
  for (const q of alterQueries) {
    try { await pool.query(q); } catch (e) { /* column may already exist */ }
  }

  console.log("Database tables initialized successfully.");
}

// Resume analysis is handled by Claude AI directly

async function startServer() {
  await initDb();
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Temporary debug endpoint - remove after verification
  app.get("/api/debug/health", async (req, res) => {
    try {
      const dbName = await pool.query("SELECT current_database()");
      const users = await pool.query("SELECT id, email, name, role FROM users");
      const seq = await pool.query("SELECT last_value, is_called FROM users_id_seq");
      res.json({
        database: dbName.rows[0].current_database,
        userCount: users.rows.length,
        users: users.rows,
        sequence: seq.rows[0],
        connectionString: (process.env.DATABASE_URL || "fallback").replace(/:[^:@]+@/, ':***@')
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: "File size too large." });
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: "Invalid JSON payload" });
    }
    next(err);
  });

  app.post("/api/auth/register", async (req, res) => {
    const { email, password, name, role, expertise } = req.body;
    try {
      // Check if email already exists
      const checkResult = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
      if (checkResult.rows.length > 0) {
         return res.status(400).json({ error: "Email already in use." });
      }

      const result = await pool.query(
        "INSERT INTO users (email, password, name, role, expertise) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [email, password, name, role, expertise]
      );
      res.json({ id: result.rows[0].id, email, name, role });
    } catch (e: any) {
      res.status(400).json({ error: e.message || "Registration failed" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    try {
      const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
      if (result.rows.length === 0) {
         return res.status(401).json({ error: "Email not found." });
      }
      
      const user = result.rows[0];
      if (user.password !== password) {
         return res.status(401).json({ error: "Incorrect password." });
      }

      res.json(user);
    } catch (e) {
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/users/update", async (req, res) => {
    const {
      id, bio, expertise, resume_url, photo_url, college, city, state, github_url, linkedin_url, skills, grad_year
    } = req.body;
    try {
      await pool.query(`
        UPDATE users SET 
          bio = $1, expertise = $2, resume_url = $3, photo_url = $4, 
          college = $5, city = $6, state = $7, github_url = $8, 
          linkedin_url = $9, skills = $10, grad_year = $11
        WHERE id = $12
      `, [bio, expertise, resume_url, photo_url, college, city, state, github_url, linkedin_url, skills, grad_year, id]);

      const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
      res.json(result.rows[0]);
    } catch (e) {
      res.status(400).json({ error: "Failed to update profile" });
    }
  });

  app.post("/api/aptitude/submit", async (req, res) => {
    const { student_id, section, score, total, is_mock } = req.body;
    try {
      await pool.query(
        "INSERT INTO aptitude_scores (student_id, section, score, total, is_mock) VALUES ($1, $2, $3, $4, $5)",
        [student_id, section, score, total, is_mock ? true : false]
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to submit score" });
    }
  });

  app.get("/api/aptitude/scores/:studentId", async (req, res) => {
    try {
      const result = await pool.query("SELECT * FROM aptitude_scores WHERE student_id = $1 ORDER BY timestamp DESC", [req.params.studentId]);
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.get("/api/experts", async (req, res) => {
    const role = req.query.role;
    try {
      let result;
      if (role) {
        result = await pool.query("SELECT id, name, expertise, bio FROM users WHERE role = 'expert' AND expertise = $1", [role]);
      } else {
        result = await pool.query("SELECT id, name, expertise, bio FROM users WHERE role = 'expert'");
      }
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/availability", async (req, res) => {
    const { expert_id, slots } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("DELETE FROM availability WHERE expert_id = $1 AND status = 'available'", [expert_id]);
      for (const slot of slots) {
        if (slot.status !== 'booked') {
          await client.query(
            "INSERT INTO availability (expert_id, start_time, end_time) VALUES ($1, $2, $3)",
            [expert_id, slot.start_time, slot.end_time]
          );
        }
      }
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: "Failed to update availability" });
    } finally {
      client.release();
    }
  });

  app.get("/api/availability/:expertId", async (req, res) => {
    try {
      const result = await pool.query("SELECT * FROM availability WHERE expert_id = $1", [req.params.expertId]);
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/bookings", async (req, res) => {
    const { student_id, expert_id, role, start_time, end_time, slot_id } = req.body;
    const meet_link = `https://meet.google.com/mock-${Math.random().toString(36).substring(7)}`;
    try {
      const result = await pool.query(
        "INSERT INTO bookings (student_id, expert_id, role, start_time, end_time, meet_link) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [student_id, expert_id, role, start_time, end_time, meet_link]
      );
      await pool.query("UPDATE availability SET status = 'booked' WHERE id = $1", [slot_id]);
      res.json({ id: result.rows[0].id, meet_link });
    } catch (e) {
      res.status(500).json({ error: "Failed to create booking" });
    }
  });

  app.get("/api/bookings/student/:studentId", async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT b.*, u.name as expert_name, u.expertise as expert_role 
        FROM bookings b 
        JOIN users u ON b.expert_id = u.id 
        WHERE b.student_id = $1
      `, [req.params.studentId]);
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.get("/api/bookings/expert/:expertId", async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT b.*, u.name as student_name, u.email as student_email, u.bio as student_bio, 
               u.photo_url as student_photo, u.resume_url as student_resume, 
               u.github_url as student_github, u.linkedin_url as student_linkedin,
               u.college as student_college, u.city as student_city, u.state as student_state,
               u.skills as student_skills, u.grad_year as student_grad_year
        FROM bookings b 
        JOIN users u ON b.student_id = u.id 
        WHERE b.expert_id = $1
      `, [req.params.expertId]);
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/bookings/:id/join", async (req, res) => {
    const { role } = req.body;
    try {
      if (role === 'expert') {
        await pool.query("UPDATE bookings SET expert_joined = true WHERE id = $1", [req.params.id]);
      }
      const result = await pool.query("SELECT expert_joined FROM bookings WHERE id = $1", [req.params.id]);
      res.json(result.rows[0]);
    } catch (e) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/bookings/:id/rate", async (req, res) => {
    const { rating, feedback } = req.body;
    try {
      await pool.query("UPDATE bookings SET rating = $1, feedback = $2, status = 'completed' WHERE id = $3", [rating, feedback, req.params.id]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.get("/api/experts/:id/earnings", async (req, res) => {
    try {
      const result = await pool.query("SELECT COUNT(*) as count FROM bookings WHERE expert_id = $1 AND status = 'completed'", [req.params.id]);
      const count = parseInt(result.rows[0].count, 10) || 0;
      const totalEarnings = count * 50;
      res.json({ total: totalEarnings, count: count });
    } catch (e) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.get("/api/experts/:id/reviews", async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT b.rating, b.feedback, b.start_time, u.name as student_name 
        FROM bookings b 
        JOIN users u ON b.student_id = u.id 
        WHERE b.expert_id = $1 AND b.rating IS NOT NULL
        ORDER BY b.start_time DESC
      `, [req.params.id]);
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // --- Synchronized Selection Rounds API ---
  
  // SSE global clients
  let sseClients: any[] = [];
  
  app.get("/api/rounds/stream", (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
  });

  const broadcastEvent = (event: string, data: any) => {
     sseClients.forEach(client => client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  app.get("/api/rounds", async (req, res) => {
    const result = await pool.query("SELECT * FROM selection_rounds ORDER BY created_at DESC");
    res.json(result.rows);
  });

  app.post("/api/rounds/create", async (req, res) => {
    const { company, target_roles, test_schema } = req.body;
    try {
       const result = await pool.query(
          "INSERT INTO selection_rounds (company, target_roles, status, test_schema) VALUES ($1, $2, 'ready', $3) RETURNING id",
          [company, JSON.stringify(target_roles), JSON.stringify(test_schema)]
       );
       const round = await pool.query("SELECT * FROM selection_rounds WHERE id = $1", [result.rows[0].id]);
       broadcastEvent('round_ready', round.rows[0]);
       res.json(round.rows[0]);
    } catch(e) { console.error("Create round error:", e); res.status(500).json({error: "Failed to create round"}); }
  });

  app.post("/api/rounds/:id/status", async (req, res) => {
    const { status } = req.body;
    try {
      await pool.query("UPDATE selection_rounds SET status = $1 WHERE id = $2", [status, req.params.id]);
      const round = await pool.query("SELECT * FROM selection_rounds WHERE id = $1", [req.params.id]);
      
      if (status === 'ready') broadcastEvent('round_ready', round.rows[0]);
      if (status === 'in_progress') {
         await pool.query("UPDATE round_participants SET status = 'testing' WHERE round_id = $1 AND status = 'waiting'", [req.params.id]);
         broadcastEvent('round_started', round.rows[0]);
      }
      if (status === 'completed') {
         await pool.query("UPDATE round_participants SET status = 'completed' WHERE round_id = $1 AND status = 'testing'", [req.params.id]);
         broadcastEvent('round_completed', round.rows[0]);
      }
      
      res.json({success: true});
    } catch(e) { res.status(500).json({error: "Failed to update status"}); }
  });

  app.get("/api/rounds/:id/participants", async (req, res) => {
    try {
       const result = await pool.query(`
          SELECT rp.*, u.name 
          FROM round_participants rp 
          JOIN users u ON rp.student_id = u.id 
          WHERE rp.round_id = $1
       `, [req.params.id]);
       res.json(result.rows);
    } catch(e) { res.status(500).json({error: "DB Error"}); }
  });

  app.post("/api/rounds/:id/join", async (req, res) => {
    const { student_id, uid, branch } = req.body;
    try {
       await pool.query(
          "INSERT INTO round_participants (round_id, student_id, uid, branch, status) VALUES ($1, $2, $3, $4, 'waiting')",
          [req.params.id, student_id, uid, branch]
       );
       res.json({success: true});
    } catch(e) { res.status(500).json({error: "Failed to join"}); }
  });

  app.post("/api/rounds/:id/submit", async (req, res) => {
    const { student_id, score, total, score_details, fit_tags } = req.body;
    try {
       await pool.query(
         "UPDATE round_participants SET status = 'completed', score = $1, total = $2, score_details = $3, fit_tags = $4 WHERE round_id = $5 AND student_id = $6",
         [score, total, JSON.stringify(score_details), JSON.stringify(fit_tags), req.params.id, student_id]
       );
       res.json({success: true});
    } catch(e) { res.status(500).json({error: "Submission failed"}); }
  });

  app.get("/api/rounds/student/:studentId/history", async (req, res) => {
    try {
       const result = await pool.query(`
          SELECT rp.*, sr.company, sr.target_roles, sr.created_at
          FROM round_participants rp 
          JOIN selection_rounds sr ON rp.round_id = sr.id 
          WHERE rp.student_id = $1 AND rp.status IN ('completed', 'selected')
          ORDER BY sr.created_at DESC
       `, [req.params.studentId]);
       res.json(result.rows);
    } catch(e) { 
       res.status(500).json({error: "Database error"}); 
    }
  });

  app.post("/api/rounds/:id/select_participant", async (req, res) => {
    const { student_id } = req.body;
    try {
       await pool.query("UPDATE round_participants SET status = 'selected' WHERE round_id = $1 AND student_id = $2", [req.params.id, student_id]);
       const round = await pool.query('SELECT company FROM selection_rounds WHERE id = $1', [req.params.id]);
       const company = round.rows[0]?.company || 'Unknown Company';
       broadcastEvent('interview_list_ready', { round_id: req.params.id, company, message: `Candidate list for ${company}'s round is released` });
       res.json({success: true});
    } catch(e) { res.status(500).json({error: "Failed"}); }
  });

  app.post("/api/rounds/:id/bulk_select", async (req, res) => {
    const { student_ids } = req.body;
    try {
       // First sequence resets all participants to completed to ensure a clean slate
       await pool.query("UPDATE round_participants SET status = 'completed' WHERE round_id = $1 AND status = 'selected'", [req.params.id]);
       for (const sid of student_ids) {
          await pool.query("UPDATE round_participants SET status = 'selected' WHERE round_id = $1 AND student_id = $2", [req.params.id, sid]);
       }
       res.json({success: true});
    } catch(e) { res.status(500).json({error: "Failed"}); }
  });

  app.post("/api/rounds/:id/finalize_list", async (req, res) => {
    try {
       const round = await pool.query('SELECT company FROM selection_rounds WHERE id = $1', [req.params.id]);
       const company = round.rows[0]?.company || 'Unknown Company';
       broadcastEvent('interview_list_ready', { round_id: req.params.id, company, message: `Candidate list for ${company}'s round is released` });
       res.json({success: true});
    } catch(e) { res.status(500).json({error: "Failed"}); }
  });

  app.post("/api/interviews/schedule", async (req, res) => {
    const { student_id, expert_id, role, start_time } = req.body;
    try {
       // Convert string date to local timestamp for sqlite (end time = start + 1hr)
       const end_time = new Date(new Date(start_time).getTime() + 60*60*1000).toISOString();
       await pool.query(
          "INSERT INTO bookings (student_id, expert_id, role, start_time, end_time, meet_link, status) VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')",
          [student_id, expert_id, role, start_time, end_time, "https://meet.google.com/mock-link"]
       );
       broadcastEvent('interview_scheduled', { student_id, role, start_time });
       broadcastEvent('interview_scheduled', { student_id, start_time, role });
       res.json({success: true});
    } catch(e) { res.status(500).json({error: "Failed to schedule"}); }
  });

  app.get("/api/experts/shortlisted", async (req, res) => {
    try {
       const result = await pool.query(`
         SELECT rp.*, u.name as student_name, sr.company,
         (SELECT count(*) FROM bookings b WHERE b.student_id = rp.student_id AND b.status = 'scheduled') as is_scheduled
         FROM round_participants rp
         JOIN users u ON u.id = rp.student_id
         JOIN selection_rounds sr ON sr.id = rp.round_id
         WHERE rp.status = 'selected' 
         ORDER BY sr.created_at DESC
       `);
       res.json(result.rows);
    } catch(e) { res.status(500).json({error: "Failed to load"}); }
  });

  // --- Claude (Anthropic) Resume Analysis Endpoint ---
  const uploadsDir = path.join(__dirname, "uploads");
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  const upload = multer({ dest: uploadsDir, limits: { fileSize: 5 * 1024 * 1024 } });

  app.post("/api/resume/analyze", upload.single("file"), async (req: any, res: any) => {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "Anthropic API key is not configured. Set ANTHROPIC_API_KEY in .env" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const targetRole = req.body.targetRole || "Software Engineer";

    try {
      // Read file and convert to base64
      const fileBuffer = fs.readFileSync(req.file.path);
      const base64Data = fileBuffer.toString("base64");

      // Clean up uploaded file immediately
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }

      // Call Claude API with the PDF
      const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: base64Data
                  }
                },
                {
                  type: "text",
                  text: `You are an expert resume analyzer and ATS (Applicant Tracking System) specialist. Analyze this resume for the role of "${targetRole}".

You MUST respond with ONLY valid JSON (no markdown, no backticks, no explanation before or after). The JSON must match this exact structure:

{
  "score": <number 0-100>,
  "targetRole": "${targetRole}",
  "parsedInfo": {
    "name": "<candidate name>",
    "email": "<email or empty string>",
    "phone": "<phone or empty string>",
    "skillsCount": <number>,
    "experienceCount": <number>,
    "educationCount": <number>,
    "certificationsCount": <number>,
    "skills": ["<skill1>", "<skill2>", ...],
    "experience": [{"company": "<name>", "title": "<job title>", "dates": "<date range>"}],
    "education": [{"institution": "<name>", "degree": "<degree>"}]
  },
  "breakdown": [
    {"category": "Contact Information", "score": <0-10>, "max": 10, "feedback": "<one line>"},
    {"category": "Professional Summary", "score": <0-15>, "max": 15, "feedback": "<one line>"},
    {"category": "Work Experience", "score": <0-25>, "max": 25, "feedback": "<one line>"},
    {"category": "Skills & Keywords", "score": <0-20>, "max": 20, "feedback": "<one line>"},
    {"category": "Education", "score": <0-15>, "max": 15, "feedback": "<one line>"},
    {"category": "ATS Compatibility", "score": <0-15>, "max": 15, "feedback": "<one line>"}
  ],
  "strengths": ["<strength1>", "<strength2>", ...],
  "suggestions": ["<actionable suggestion1>", "<actionable suggestion2>", ...],
  "atsOptimization": {
    "issues": ["<ATS issue1>", "<ATS issue2>", ...],
    "matchedKeywords": ["<keyword found in resume>", ...],
    "missingKeywords": ["<important keyword missing>", ...],
    "overallAtsScore": <0-15>,
    "tips": ["<tip1>", "<tip2>", "<tip3>", "<tip4>", "<tip5>", "<tip6>"]
  }
}

Scoring rules:
- "score" is the sum of all breakdown scores (max 100)
- Be critical but fair. A perfect resume scores 85-95
- Average resumes score 45-65
- For "${targetRole}", check for role-specific technical skills and keywords
- Provide at least 3-5 strengths, 4-6 suggestions, and 3-5 ATS issues
- matchedKeywords: list skills/keywords found in the resume relevant to ${targetRole}
- missingKeywords: list important skills/keywords for ${targetRole} NOT found in the resume
- tips should be general ATS best practices

RESPOND WITH ONLY THE JSON OBJECT. NO OTHER TEXT.`
                }
              ]
            }
          ]
        })
      });

      if (!claudeResponse.ok) {
        const errText = await claudeResponse.text();
        console.error("Claude API error:", claudeResponse.status, errText);
        return res.status(502).json({ error: `Claude API error: ${claudeResponse.status}`, details: errText });
      }

      const claudeResult = await claudeResponse.json();

      // Extract text content from Claude's response
      const textContent = claudeResult.content?.find((c: any) => c.type === "text");
      if (!textContent?.text) {
        return res.status(500).json({ error: "Claude returned no text response" });
      }

      // Parse the JSON from Claude's response (strip any markdown if present)
      let jsonText = textContent.text.trim();
      // Remove markdown code fences if Claude wraps the response
      if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
      }

      const analysis = JSON.parse(jsonText);
      res.json(analysis);
    } catch (error: any) {
      console.error("Resume analysis error:", error);
      try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
      res.status(500).json({ error: "Failed to analyze resume: " + error.message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
