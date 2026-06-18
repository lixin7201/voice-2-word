create extension if not exists "pgcrypto";

create table if not exists departments (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  employee_no text,
  login_name text not null unique,
  display_name text not null,
  password_hash text not null,
  global_role text not null default 'employee',
  status text not null default 'active',
  avatar_url text,
  avatar_r2_key text,
  avatar_color text,
  bio text,
  ai_profile_note text,
  profile_updated_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists employee_departments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  department_id uuid not null references departments(id),
  member_role text not null default 'member',
  created_at timestamptz not null default now(),
  unique(employee_id, department_id, member_role)
);

create table if not exists audio_records (
  id uuid primary key default gen_random_uuid(),
  owner_employee_id uuid not null references employees(id),
  owner_department_id uuid references departments(id),
  title text not null,
  title_source text not null default 'filename',
  title_locked boolean not null default false,
  ai_title text,
  title_updated_at timestamptz,
  source_type text not null,
  source_page_url text,
  source_page_title text,
  source_media_url_hash text,
  original_file_name text,
  mime_type text,
  file_size bigint,
  duration_seconds integer,
  r2_key text,
  status text not null default 'created',
  processing_started_at timestamptz,
  transcribe_started_at timestamptz,
  summarize_started_at timestamptz,
  last_progress_at timestamptz,
  asr_task_id text,
  processing_attempts integer not null default 0,
  template_type text not null default 'meeting_minutes',
  followup_type text not null default 'none',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text
);

create table if not exists record_processing_events (
  id uuid primary key default gen_random_uuid(),
  audio_record_id uuid not null references audio_records(id),
  phase text not null,
  message text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists transcripts (
  id uuid primary key default gen_random_uuid(),
  audio_record_id uuid not null references audio_records(id),
  asr_provider text,
  asr_task_id text,
  raw_text text,
  corrected_text text,
  segments_json jsonb not null default '[]'::jsonb,
  speaker_aliases_json jsonb not null default '{}'::jsonb,
  duration_ms integer,
  cost_cny numeric(10, 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists summaries (
  id uuid primary key default gen_random_uuid(),
  audio_record_id uuid not null references audio_records(id),
  template_type text not null,
  summary_markdown text,
  overview_card_json jsonb not null default '{}'::jsonb,
  mind_map_json jsonb not null default '{}'::jsonb,
  structured_json jsonb not null default '{}'::jsonb,
  model_provider text,
  model_name text,
  model_error text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists followup_forms (
  id uuid primary key default gen_random_uuid(),
  audio_record_id uuid not null references audio_records(id),
  business_type text,
  stage text,
  customer_name text,
  company_name text,
  status_label text,
  suggested_tag text,
  followup_markdown text,
  fields_json jsonb not null default '{}'::jsonb,
  manual_edited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists record_notes (
  id uuid primary key default gen_random_uuid(),
  audio_record_id uuid not null references audio_records(id),
  employee_id uuid not null references employees(id),
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists export_files (
  id uuid primary key default gen_random_uuid(),
  audio_record_id uuid not null references audio_records(id),
  export_type text not null,
  format text not null,
  storage text not null default 'local',
  r2_key text not null,
  created_by uuid not null references employees(id),
  created_at timestamptz not null default now()
);

create table if not exists system_settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value text,
  is_secret boolean not null default false,
  updated_by uuid references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists system_meta (
  id uuid primary key default gen_random_uuid(),
  schema_version integer not null default 2,
  settings_version integer not null default 1,
  settings_updated_at timestamptz,
  settings_updated_by uuid references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_employee_id uuid references employees(id),
  action text not null,
  target_type text not null,
  target_id text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists ztools_daily_digest_queue (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  date date not null,
  record_ids_json jsonb not null default '[]'::jsonb,
  digest_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_audio_records_owner on audio_records(owner_employee_id);
create index if not exists idx_audio_records_department on audio_records(owner_department_id);
create index if not exists idx_audio_records_status on audio_records(status);
create index if not exists idx_audio_records_asr_task_id on audio_records(asr_task_id);
create index if not exists idx_audio_records_created_at on audio_records(created_at);
create index if not exists idx_record_processing_events_record on record_processing_events(audio_record_id);
create index if not exists idx_system_settings_key on system_settings(key);
