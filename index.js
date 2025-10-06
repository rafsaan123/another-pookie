#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { setGlobalDispatcher, Agent } from 'undici';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// Enable HTTP keep-alive for faster outbound requests
setGlobalDispatcher(new Agent({ keepAlive: true, keepAliveTimeout: 10_000, keepAliveMaxTimeout: 10_000, connections: 128 }));

// Tunable timeouts (ms)
const PROJECT_TIMEOUT_MS = Number(process.env.PROJECT_TIMEOUT_MS || 500);
const GPA_TIMEOUT_MS = Number(process.env.GPA_TIMEOUT_MS || 300);
const CGPA_TIMEOUT_MS = Number(process.env.CGPA_TIMEOUT_MS || 200);
const WEB_TIMEOUT_MS = Number(process.env.WEB_TIMEOUT_MS || 600);

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

// Load multi-supabase config (reuse Python json if present)
const CONFIG_PATH = path.resolve(__dirname, '..', 'supabase_projects.json');
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const json = JSON.parse(raw);
    return json;
  } catch (e) {
    return { current_project: null, search_order: [], projects: {}, settings: {} };
  }
}

let config = loadConfig();

// Environment overrides
function applyEnvToConfig(cfg) {
  const out = { ...cfg, projects: { ...cfg.projects } };
  const envPrimaryUrl = process.env.SUPABASE_URL || process.env.SUPABASE_PRIMARY_URL;
  const envPrimaryKey = process.env.SUPABASE_KEY || process.env.SUPABASE_PRIMARY_KEY;
  if (envPrimaryUrl && envPrimaryKey) {
    out.projects.primary = {
      url: envPrimaryUrl,
      key: envPrimaryKey,
      description: (out.projects.primary && out.projects.primary.description) || 'Primary Supabase project'
    };
    if (!out.current_project) out.current_project = 'primary';
    if (!out.search_order || out.search_order.length === 0) out.search_order = ['primary'];
  }
  // Secondary (optional)
  const envSecondaryUrl = process.env.SUPABASE_SECONDARY_URL;
  const envSecondaryKey = process.env.SUPABASE_SECONDARY_KEY;
  if (envSecondaryUrl && envSecondaryKey) {
    out.projects.secondary = {
      url: envSecondaryUrl,
      key: envSecondaryKey,
      description: (out.projects.secondary && out.projects.secondary.description) || 'Secondary Supabase project'
    };
    if (!out.search_order.includes('secondary')) out.search_order.push('secondary');
  }
  return out;
}

config = applyEnvToConfig(config);

// Create lazy clients map
const clients = new Map();
function getClient(name) {
  const project = config.projects[name];
  if (!project) throw new Error(`Project ${name} not found`);
  if (!clients.has(name)) {
    clients.set(name, createClient(project.url, project.key));
  }
  return clients.get(name);
}

// No caching per requirement

async function queryStudentInProject(projectName, roll, regulation, program) {
  const client = getClient(projectName);
  const { data: student, error: studentErr } = await client
    .from('students')
    .select('roll_number, program_name, regulation_year, institute_code, created_at')
    .eq('program_name', program)
    .eq('regulation_year', regulation)
    .eq('roll_number', roll)
    .maybeSingle();

  if (studentErr) throw new Error(studentErr.message);
  if (!student) return null;

  const { data: institutes } = await client
    .from('institutes')
    .select('institute_code, name, district')
    .eq('program_name', program)
    .eq('regulation_year', regulation)
    .eq('institute_code', student.institute_code)
    .limit(1);

  const institute = institutes && institutes[0] ? institutes[0] : null;

  return { student, institute };
}

async function fetchGpaRecords(projectName, roll) {
  const client = getClient(projectName);
  const { data, error } = await client
    .from('gpa_records')
    .select('semester, gpa, is_reference, ref_subjects, created_at')
    .eq('roll_number', roll)
    .order('semester', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function fetchCgpaRecordsAcrossProjects(roll) {
  const names = config.search_order || Object.keys(config.projects);
  const queries = names.map(name => withTimeout((async () => {
    const client = getClient(name);
    const { data, error } = await client
      .from('cgpa_records')
      .select('semester, cgpa, created_at')
      .eq('roll_number', roll)
      .limit(20);
    if (error) throw error;
    if (data && data.length) {
      return data.map(r => ({
        semester: r.semester || 'Final',
        cgpa: String(r.cgpa ?? '0.00'),
        publishedAt: r.created_at || '2025-01-01T00:00:00Z'
      }));
    }
    throw new Error('empty');
  })(), CGPA_TIMEOUT_MS));

  try {
    return await Promise.any(queries);
  } catch (_) {
    return [];
  }
}

// Web API fallback (disabled for sub-second latency target)
async function webApiFallback(roll, regulation, program) {
  const baseUrl = 'https://btebresulthub-server.vercel.app';
  const url = `${baseUrl}/results/individual/${encodeURIComponent(roll)}`;
  const params = { exam: program, regulation };
  try {
    const resp = await axios.get(url, { params, timeout: WEB_TIMEOUT_MS, headers: { 'User-Agent': 'BTEB-Results-App/1.0' } });
    if (resp.status !== 200) return null;
    const data = resp.data;
    // Convert to internal format similar to Python
    const gpaRecords = (data.resultData || []).map(r => ({
      semester: Number(r.semester || 1),
      gpa: typeof r.result === 'number' ? r.result : (r.result === 'ref' ? null : Number(r.result)),
      is_reference: r.result === 'ref' || r.passed === false,
      ref_subjects: Array.isArray(r.result?.ref_subjects) ? r.result.ref_subjects : [],
      created_at: r.publishedAt || '2025-01-01T00:00:00Z'
    }));
    return {
      source: 'web_api_btebresulthub',
      student: {
        roll_number: data.roll || roll,
        program_name: data.exam || program,
        regulation_year: data.regulation || regulation,
        institute_code: data.instituteData?.code || '00000',
        created_at: data.time || '2025-01-01T00:00:00Z'
      },
      institute: {
        name: data.instituteData?.name || 'Unknown',
        district: data.instituteData?.district || 'Unknown',
        institute_code: data.instituteData?.code || '00000'
      },
      gpaRecords
    };
  } catch (_) {
    return null;
  }
}

// Health
app.get('/health', async (req, res) => {
  try {
    const name = config.current_project || config.search_order[0];
    if (!name) return res.status(500).json({ status: 'unhealthy', supabase_connected: false });
    const client = getClient(name);
    const { data, error } = await client.from('programs').select('*').limit(1);
    if (error) throw error;
    return res.json({ status: 'healthy', supabase_connected: true, current_project: name, available_projects: Object.keys(config.projects) });
  } catch (e) {
    return res.status(500).json({ status: 'unhealthy', supabase_connected: false, error: String(e.message || e) });
  }
});

// Projects list
app.get('/api/projects', (req, res) => {
  const info = {};
  for (const [name, project] of Object.entries(config.projects)) {
    info[name] = { name, description: project.description, url: project.url, is_active: name === config.current_project };
  }
  res.json(info);
});

// Switch project
app.post('/api/projects/:project/switch', (req, res) => {
  const name = req.params.project;
  if (!config.projects[name]) return res.status(404).json({ error: `Project ${name} not found` });
  config.current_project = name;
  res.json({ message: `Switched to project: ${name}`, current_project: name });
});

// Search result: try Supabase projects first (first-success), then web fallback
app.post('/api/search-result', async (req, res) => {
  const { rollNo, regulation, program } = req.body || {};
  if (!rollNo || !regulation || !program) return res.status(400).json({ error: 'Missing required fields: rollNo, regulation, program' });

  const order = config.search_order || Object.keys(config.projects);
  // Query all Supabase projects in parallel; resolve on first success (with per-project timeout)
  const projectPromises = order.map(name => withTimeout(
    queryStudentInProject(name, rollNo, regulation, program)
      .then(r => (r ? { ...r, project_name: name } : Promise.reject(new Error('not_found')))),
    PROJECT_TIMEOUT_MS
  ));

  let winner = null;
  try {
    winner = await Promise.any(projectPromises);
  } catch (_) {
    winner = null;
  }

  if (winner) {
    // Winner from Supabase: fetch GPA and CGPA (like Python)
    const [gpas, cgpas] = await Promise.all([
      withTimeout(fetchGpaRecords(winner.project_name, rollNo), GPA_TIMEOUT_MS).catch(() => []),
      withTimeout(fetchCgpaRecordsAcrossProjects(rollNo), CGPA_TIMEOUT_MS).catch(() => [])
    ]);

    const transformed = {
      success: true,
      roll: winner.student.roll_number,
      regulation: winner.student.regulation_year,
      exam: winner.student.program_name,
      instituteData: {
        code: winner.institute?.institute_code || '00000',
        name: winner.institute?.name || 'Unknown',
        district: winner.institute?.district || 'Unknown'
      },
      resultData: gpas.map(g => ({
        publishedAt: g.created_at || '2025-01-01T00:00:00Z',
        semester: String(g.semester || 1),
        result: { gpa: g.gpa == null ? 'ref' : String(g.gpa), ref_subjects: Array.isArray(g.ref_subjects) ? g.ref_subjects : [] },
        passed: g.is_reference ? false : true,
        gpa: g.gpa == null ? 'ref' : String(g.gpa)
      })),
      cgpaData: cgpas
    };
    return res.json(transformed);
  }

  // If not found in any Supabase project, try web fallback
  const fallback = await webApiFallback(rollNo, regulation, program);
  if (fallback) {
    const transformedWeb = {
      success: true,
      time: fallback.student.created_at || '2025-01-01T00:00:00Z',
      roll: fallback.student.roll_number,
      regulation: fallback.student.regulation_year,
      exam: fallback.student.program_name,
      found_in_project: fallback.source || 'web_api',
      projects_searched: (config.search_order || Object.keys(config.projects)).concat(['web_apis']),
      source: 'web_api',
      instituteData: {
        code: fallback.institute?.institute_code || '00000',
        name: fallback.institute?.name || 'Unknown',
        district: fallback.institute?.district || 'Unknown'
      },
      resultData: (fallback.gpaRecords || []).map(g => ({
        publishedAt: g.created_at || '2025-01-01T00:00:00Z',
        semester: String(g.semester || 1),
        passed: g.is_reference ? false : true,
        gpa: g.gpa == null ? 'ref' : String(g.gpa),
        result: { gpa: g.gpa == null ? 'ref' : String(g.gpa), ref_subjects: Array.isArray(g.ref_subjects) ? g.ref_subjects : [] }
      })),
      cgpaData: []
    };
    return res.json(transformedWeb);
  }

  return res.status(404).json({
    success: false,
    error: 'Student not found in any database or web API',
    roll: rollNo,
    regulation,
    exam: program,
    projects_searched: config.search_order || Object.keys(config.projects),
    web_apis_tried: ['btebresulthub']
  });
});

// Regulations (simple)
app.get('/api/regulations/:program', async (req, res) => {
  try {
    const name = config.current_project || config.search_order[0];
    const client = getClient(name);
    const { data, error } = await client
      .from('regulations')
      .select('regulation_year')
      .eq('program_name', req.params.program);
    if (error) throw error;
    res.json({ regulations: (data || []).map(r => r.regulation_year) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`Node API listening on :${port}`);
});


