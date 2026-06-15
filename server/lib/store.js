const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createInitialData } = require('./seed');

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.data = createInitialData();
      this.save();
      return this.data;
    }
    this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  table(name) {
    if (!this.data) this.load();
    if (!Array.isArray(this.data[name])) this.data[name] = [];
    return this.data[name];
  }

  insert(tableName, row) {
    const now = new Date().toISOString();
    const record = {
      id: row.id || crypto.randomUUID(),
      created_at: row.created_at || now,
      updated_at: row.updated_at || now,
      ...row,
    };
    this.table(tableName).push(record);
    this.save();
    return record;
  }

  update(tableName, id, updates) {
    const table = this.table(tableName);
    const index = table.findIndex((row) => row.id === id);
    if (index === -1) return null;
    table[index] = {
      ...table[index],
      ...updates,
      updated_at: new Date().toISOString(),
    };
    this.save();
    return table[index];
  }

  delete(tableName, id) {
    const table = this.table(tableName);
    const index = table.findIndex((row) => row.id === id);
    if (index === -1) return false;
    table.splice(index, 1);
    this.save();
    return true;
  }

  findById(tableName, id) {
    return this.table(tableName).find((row) => row.id === id) || null;
  }
}

module.exports = {
  JsonStore,
};
