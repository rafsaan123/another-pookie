#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// Configuration - Two Supabase projects
const PRIMARY_URL = process.env.SUPABASE_PRIMARY_URL || 'https://hddphaneexloretrisiy.supabase.co';
const PRIMARY_KEY = process.env.SUPABASE_PRIMARY_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkZHBoYW5lZXhsb3JldHJpc2l5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg2MTEzNjksImV4cCI6MjA3NDE4NzM2OX0.eMyOCUDI-iqcGY_tJUbAMw41sPnDDXfHbdMJNfcwP-w';

const SECONDARY_URL = process.env.SUPABASE_SECONDARY_URL || 'https://ncjleyktzilulflbjfdg.supabase.co';
const SECONDARY_KEY = process.env.SUPABASE_SECONDARY_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jamxleWt0emlsdWxmbGJqZmRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg2MjI2OTUsImV4cCI6MjA3NDE5ODY5NX0.ScbXuVjULWWyCJt4IuKhUhSunkRg0H0XVVysR7756b0';

const WEB_API_BASE = 'https://btebresulthub-server.vercel.app';

// Timeouts (ms)
const DB_TIMEOUT = Number(process.env.DB_TIMEOUT || 2000);
const WEB_TIMEOUT = Number(process.env.WEB_TIMEOUT || 3000);

// Create Supabase clients
const primaryClient = createClient(PRIMARY_URL, PRIMARY_KEY);
const secondaryClient = createClient(SECONDARY_URL, SECONDARY_KEY);

// Utility: timeout wrapper
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

// Fetch student + institute from a Supabase client
async function fetchFromSupabaseClient(client, roll, regulation, program) {
  try {
    // Single query with JOIN
    const { data: student, error: studentErr } = await client
      .from('students')
      .select(`
        roll_number,
        program_name,
        regulation_year,
        institute_code,
        created_at,
        institutes!inner(institute_code, name, district)
      `)
      .eq('program_name', program)
      .eq('regulation_year', regulation)
      .eq('roll_number', roll)
      .eq('institutes.program_name', program)
      .eq('institutes.regulation_year', regulation)
      .maybeSingle();

    if (studentErr || !student) return null;

    // Fetch GPA and CGPA in parallel
    const [gpaRes, cgpaRes] = await Promise.allSettled([
      client
        .from('gpa_records')
        .select('semester, gpa, is_reference, ref_subjects, created_at')
        .eq('roll_number', roll)
        .order('semester', { ascending: true }),
      client
        .from('cgpa_records')
        .select('semester, cgpa, created_at')
        .eq('roll_number', roll)
        .order('semester', { ascending: true })
        .limit(20)
    ]);

    const gpaRecords = gpaRes.status === 'fulfilled' && !gpaRes.value.error ? gpaRes.value.data : [];
    const cgpaRecords = cgpaRes.status === 'fulfilled' && !cgpaRes.value.error ? cgpaRes.value.data : [];

    return {
      student,
      institute: student.institutes,
      gpaRecords,
      cgpaRecords
    };
  } catch (err) {
    return null;
  }
}

// Try both Supabase projects
async function fetchFromSupabase(roll, regulation, program) {
  // Try primary first, then secondary
  let result = await withTimeout(
    fetchFromSupabaseClient(primaryClient, roll, regulation, program),
    DB_TIMEOUT
  ).catch(() => null);

  if (result) return result;

  result = await withTimeout(
    fetchFromSupabaseClient(secondaryClient, roll, regulation, program),
    DB_TIMEOUT
  ).catch(() => null);

  return result;
}

// Format response
function formatResponse(data) {
  return {
    success: true,
    roll: data.student.roll_number,
    regulation: data.student.regulation_year,
    exam: data.student.program_name,
    instituteData: {
      code: data.institute?.institute_code || data.student.institute_code,
      name: data.institute?.name || 'Unknown',
      district: data.institute?.district || 'Unknown'
    },
    resultData: data.gpaRecords.map(g => ({
      publishedAt: g.created_at || '2025-01-01T00:00:00Z',
      semester: String(g.semester || 1),
      passed: !g.is_reference,
      gpa: g.gpa == null ? 'ref' : String(g.gpa),
      result: {
        gpa: g.gpa == null ? 'ref' : String(g.gpa),
        ref_subjects: Array.isArray(g.ref_subjects) ? g.ref_subjects : []
      }
    })),
    cgpaData: data.cgpaRecords.map(c => ({
      semester: c.semester || 'Final',
      cgpa: String(c.cgpa ?? '0.00'),
      publishedAt: c.created_at || '2025-01-01T00:00:00Z'
    }))
  };
}

// Fetch from Web API fallback
async function fetchFromWebAPI(roll, regulation, program) {
  try {
    const url = `${WEB_API_BASE}/results/individual/${encodeURIComponent(roll)}`;
    const resp = await axios.get(url, {
      params: { exam: program, regulation },
      timeout: WEB_TIMEOUT,
      headers: { 'User-Agent': 'BTEB-Results-App/1.0' }
    });

    if (resp.status !== 200 || !resp.data) return null;

    const data = resp.data;
    return {
      success: true,
      time: data.time || new Date().toISOString(),
      roll: data.roll || roll,
      regulation: data.regulation || regulation,
      exam: data.exam || program,
      source: 'web_api',
      instituteData: {
        code: data.instituteData?.code || '00000',
        name: data.instituteData?.name || 'Unknown',
        district: data.instituteData?.district || 'Unknown'
      },
      resultData: (data.resultData || []).map(r => ({
        publishedAt: r.publishedAt || '2025-01-01T00:00:00Z',
        semester: String(r.semester || 1),
        passed: r.passed !== false,
        gpa: typeof r.result === 'object' ? (r.result.gpa || 'ref') : String(r.result || 'ref'),
        result: {
          gpa: typeof r.result === 'object' ? (r.result.gpa || 'ref') : String(r.result || 'ref'),
          ref_subjects: typeof r.result === 'object' && Array.isArray(r.result.ref_subjects) ? r.result.ref_subjects : []
        }
      })),
      cgpaData: data.cgpaData || []
    };
  } catch (err) {
    return null;
  }
}

// Health check
app.get('/health', async (req, res) => {
  try {
    const [p1, p2] = await Promise.allSettled([
      primaryClient.from('programs').select('*').limit(1),
      secondaryClient.from('programs').select('*').limit(1)
    ]);
    
    res.json({
      status: 'healthy',
      primary: { connected: p1.status === 'fulfilled' && !p1.value.error, url: PRIMARY_URL },
      secondary: { connected: p2.status === 'fulfilled' && !p2.value.error, url: SECONDARY_URL }
    });
  } catch (e) {
    res.status(500).json({
      status: 'unhealthy',
      error: String(e.message || e)
    });
  }
});

// Search result endpoint
app.post('/api/search-result', async (req, res) => {
  const { rollNo, regulation, program } = req.body || {};
  
  if (!rollNo || !regulation || !program) {
    return res.status(400).json({
      error: 'Missing required fields: rollNo, regulation, program'
    });
  }

  // Try Supabase first (primary, then secondary)
  const dbResult = await fetchFromSupabase(rollNo, regulation, program);
  
  if (dbResult) {
    return res.json(formatResponse(dbResult));
  }

  // Fallback to Web API
  const webResult = await fetchFromWebAPI(rollNo, regulation, program);

  if (webResult) {
    return res.json(webResult);
  }

  // Not found
  return res.status(404).json({
    success: false,
    error: 'Student not found in database or web API',
    roll: rollNo,
    regulation,
    exam: program
  });
});

// Regulations endpoint
app.get('/api/regulations/:program', async (req, res) => {
  try {
    // Try primary first
    let { data, error } = await primaryClient
      .from('regulations')
      .select('regulation_year')
      .eq('program_name', req.params.program);
    
    // If not found, try secondary
    if (error || !data || data.length === 0) {
      const result = await secondaryClient
        .from('regulations')
        .select('regulation_year')
        .eq('program_name', req.params.program);
      data = result.data;
      error = result.error;
    }
    
    if (error) throw error;
    res.json({ regulations: (data || []).map(r => r.regulation_year) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`Node API listening on :${port}`);
  console.log(`Primary: ${PRIMARY_URL}`);
  console.log(`Secondary: ${SECONDARY_URL}`);
});
