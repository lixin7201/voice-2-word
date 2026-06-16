const crypto = require('node:crypto');
const { hashPassword } = require('./auth');

const DEPARTMENTS = [
  ['dept-management', '管理层/待分配'],
  ['dept-operations', '运营部'],
  ['dept-finance', '财务部'],
  ['dept-matchmaker', '红娘部门'],
  ['dept-recruitment', '招聘部'],
];

const EMPLOYEES = [
  '练团长',
  '王哥',
  '代姐',
  '雯雯',
  '小绵羊',
  '二毛',
  '加菲',
  '流浪',
  '小美',
  '小康',
  '泡泡',
  '甘甘',
  '小琳',
  '南风',
  '离心',
  '小田',
  '有缘',
  'Cherry',
  '芳芳',
  '莎莎',
  '三土',
  'Coco',
  '可可',
  '郭郭',
  '安安',
  '燕妮',
  '蓝玲',
  '阿贝',
  '半夏',
  '小乔',
  '猫饼',
  '妮娜',
  '三毛',
  '悠悠',
  '小严',
  '小文',
  '岚岚',
  '阿馨',
  '清英',
  '凌予',
  '云菲',
  '清风',
  '阿文',
  '毛毛',
  '周周',
  '七七',
];

const MEMBERSHIP = {
  '管理层/待分配': ['练团长', '王哥', '雯雯', '小绵羊', '七七'],
  '运营部': ['加菲', '流浪', '小美', '小康', '泡泡', '甘甘', '小琳', '南风', '离心', '小田', '有缘'],
  '财务部': ['Cherry', '芳芳', '莎莎', '三土'],
  '红娘部门': ['Coco', '可可', '郭郭', '安安', '燕妮', '蓝玲', '阿贝', '半夏', '小乔', '猫饼', '妮娜', '三毛', '悠悠', '小严', '小文'],
  '招聘部': ['岚岚', '阿馨', '清英', '凌予', '云菲', '清风', '阿文', '毛毛', '周周'],
};

function createInitialData(now = new Date().toISOString()) {
  const departmentRows = DEPARTMENTS.map(([id, name]) => ({
    id,
    name,
    status: 'active',
    created_at: now,
    updated_at: now,
  }));
  const departmentByName = new Map(departmentRows.map((department) => [department.name, department]));

  const employeeRows = EMPLOYEES.map((name, index) => ({
    id: `emp-${String(index + 1).padStart(3, '0')}`,
    employee_no: `DYB${String(index + 1).padStart(3, '0')}`,
    login_name: name,
    display_name: name,
    password_hash: hashPassword('dayibin'),
    global_role: globalRoleFor(name),
    status: 'active',
    last_login_at: null,
    created_at: now,
    updated_at: now,
  }));
  const employeeByName = new Map(employeeRows.map((employee) => [employee.display_name, employee]));

  const employeeDepartments = [];
  for (const [departmentName, names] of Object.entries(MEMBERSHIP)) {
    const department = departmentByName.get(departmentName);
    for (const name of names) {
      const employee = employeeByName.get(name);
      if (employee && department) {
        employeeDepartments.push(memberRow(employee.id, department.id, 'member', now));
      }
    }
  }

  employeeDepartments.push(memberRow(employeeByName.get('代姐').id, departmentByName.get('招聘部').id, 'lead', now));
  employeeDepartments.push(memberRow(employeeByName.get('二毛').id, departmentByName.get('运营部').id, 'lead', now));
  employeeDepartments.push(memberRow(employeeByName.get('二毛').id, departmentByName.get('红娘部门').id, 'lead', now));

  return {
    departments: departmentRows,
    employees: employeeRows,
    employee_departments: employeeDepartments,
    audio_records: [],
    transcripts: [],
    summaries: [],
    followup_forms: [],
    record_notes: [],
    export_files: [],
    system_settings: [],
    audit_logs: [],
    ztools_daily_digest_queue: [],
  };
}

function globalRoleFor(name) {
  if (name === '离心') return 'admin';
  if (name === '练团长') return 'boss';
  if (name === '代姐' || name === '二毛') return 'department_lead';
  return 'employee';
}

function memberRow(employeeId, departmentId, memberRole, now) {
  return {
    id: crypto.randomUUID(),
    employee_id: employeeId,
    department_id: departmentId,
    member_role: memberRole,
    created_at: now,
  };
}

module.exports = {
  createInitialData,
};
