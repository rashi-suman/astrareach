const multer = require('multer');
const path = require('path');
const fs = require('fs');
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`),
});
module.exports = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => ['.xlsx', '.xls', '.csv'].includes(path.extname(file.originalname).toLowerCase()) ? cb(null, true) : cb(new Error('Invalid file type')),
});
