require('dotenv').config();
const xlsx = require('xlsx');
const path = require('path');

const filePath = 'C:\\Users\\rohit\\Downloads\\HNI Data\\HNI Data\\Banglore High Income\\BANGALORE COMMERCIAL DATABASE.xls';

const workbook = xlsx.readFile(filePath, { cellDates: true });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

// Find header row
let headerRowIdx = 0, bestScore = -1;
for (let i = 0; i < Math.min(25, rows.length); i++) {
  const score = rows[i].filter(c => String(c).trim()).length;
  if (score > bestScore) { bestScore = score; headerRowIdx = i; }
}
const headers = rows[headerRowIdx].map((h, i) => String(h).trim() || `Col_${i}`);
console.log('Headers:', headers);
console.log('Total data rows:', rows.length - headerRowIdx - 1);

// Sample 5 rows
for (let i = headerRowIdx + 1; i <= Math.min(headerRowIdx + 5, rows.length - 1); i++) {
  const row = {};
  headers.forEach((h, ci) => row[h] = rows[i][ci]);
  console.log('Row', i - headerRowIdx, ':', JSON.stringify(row));
}

// Check for null bytes / bad chars
let nullByteRows = 0;
for (let i = headerRowIdx + 1; i < rows.length; i++) {
  const bad = rows[i].some(c => String(c).includes('\0') || String(c).includes('\u0000'));
  if (bad) nullByteRows++;
}
console.log('\nRows with null bytes:', nullByteRows);

// Count rows with @ in Email column
const emailIdx = headers.findIndex(h => h.toLowerCase().includes('email'));
if (emailIdx >= 0) {
  let valid = 0, empty = 0, invalid = 0;
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const v = String(rows[i][emailIdx] || '').trim();
    if (!v) empty++;
    else if (v.includes('@')) valid++;
    else invalid++;
  }
  console.log(`\nEmail column "${headers[emailIdx]}": valid=${valid} empty=${empty} invalid=${invalid}`);
}
