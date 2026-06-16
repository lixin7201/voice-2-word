const crypto = require('node:crypto');

function buildExportText(record, store, target = 'full_record', markdown = true) {
  const summary = store.table('summaries').find((item) => item.audio_record_id === record.id);
  const transcript = store.table('transcripts').find((item) => item.audio_record_id === record.id);
  const followup = store.table('followup_forms').find((item) => item.audio_record_id === record.id);
  const owner = store.findById('employees', record.owner_employee_id)?.display_name || '';
  const department = record.owner_department_id ? store.findById('departments', record.owner_department_id)?.name || '' : '';
  const sections = [
    titleLine(record.title, markdown),
    '',
    `员工：${owner}`,
    `部门：${department}`,
    `创建时间：${record.created_at}`,
    `来源：${record.source_page_title || record.source_type}`,
    `模板：${record.template_type}`,
    '',
  ];
  if (target !== 'transcript') sections.push(heading('总结', markdown), summary?.summary_markdown || '暂无总结', '');
  if (target !== 'summary') sections.push(heading('逐字稿', markdown), transcript?.corrected_text || transcript?.raw_text || '暂无逐字稿', '');
  if (target !== 'summary' && target !== 'transcript') sections.push(heading('跟单', markdown), followup?.followup_markdown || '暂无跟单', '');
  return sections.filter((item) => item !== undefined).join('\n');
}

function titleLine(title, markdown) {
  return markdown ? `# ${title}` : title;
}

function heading(title, markdown) {
  return markdown ? `## ${title}` : `【${title}】`;
}

function stripMarkdown(markdown) {
  return markdown
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^- /gm, '· ');
}

function createDocxBuffer(title, text) {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${paragraph(title, true)}${text.split(/\n+/).map((line) => paragraph(line)).join('')}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>` +
    `</w:body></w:document>`;
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': documentXml,
  };
  return zipStore(files);
}

function paragraph(text, bold = false) {
  const value = escapeXml(text || ' ');
  const runProps = bold ? '<w:rPr><w:b/></w:rPr>' : '';
  return `<w:p><w:r>${runProps}<w:t xml:space="preserve">${value}</w:t></w:r></w:p>`;
}

function createPdfBuffer(title, text) {
  const lines = [title, '', ...stripMarkdown(text).split(/\n+/)].flatMap((line) => wrapLine(line, 32));
  const pages = [];
  for (let index = 0; index < lines.length; index += 34) pages.push(lines.slice(index, index + 34));
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const fontId = add('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [ << /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >> ] >>');
  const pageIds = [];
  for (const pageLines of pages.length ? pages : [[]]) {
    const content = [
      'BT',
      `/F1 11 Tf`,
      '48 790 Td',
      ...pageLines.map((line, index) => `${index ? '0 -21 Td ' : ''}<${utf16beHex(line || ' ')}> Tj`),
      'ET',
    ].join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent 0 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  pageIds.forEach((pageId) => {
    objects[pageId - 1] = objects[pageId - 1].replace('/Parent 0 0 R', `/Parent ${pagesId} 0 R`);
  });
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  return buildPdf(objects, catalogId);
}

function wrapLine(line, max) {
  const text = String(line || '');
  if (text.length <= max) return [text];
  const output = [];
  for (let index = 0; index < text.length; index += max) output.push(text.slice(index, index + max));
  return output;
}

function buildPdf(objects, catalogId) {
  const chunks = ['%PDF-1.4\n'];
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(chunks.join('')));
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  });
  const xrefOffset = Buffer.byteLength(chunks.join(''));
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (let index = 1; index <= objects.length; index += 1) {
    chunks.push(`${String(offsets[index]).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return Buffer.from(chunks.join(''));
}

function zipStore(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function utf16beHex(value) {
  const utf16le = Buffer.from(String(value).replace(/[()\\]/g, ''), 'utf16le');
  for (let index = 0; index < utf16le.length; index += 2) {
    const left = utf16le[index];
    utf16le[index] = utf16le[index + 1];
    utf16le[index + 1] = left;
  }
  return utf16le.toString('hex');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hashContent(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = {
  buildExportText,
  createDocxBuffer,
  createPdfBuffer,
  hashContent,
  stripMarkdown,
};
