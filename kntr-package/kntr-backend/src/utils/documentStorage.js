const fs = require('node:fs');
const path = require('node:path');
const { query } = require('../config/database');

const safeName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}\.(jpg|jpeg|png|pdf)$/i;
const uploadRoot = () => path.resolve(process.env.UPLOAD_PATH || path.join(__dirname, '../../uploads'));
const resolveFilename = name => {
  if (typeof name !== 'string' || !safeName.test(name)) return null;
  const filename = path.join(uploadRoot(), name);
  try {
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return filename;
};
const legacyFilename = url => {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return null;
  const name = url.slice('/uploads/'.length);
  return safeName.test(name) ? name : null;
};
const removeUnreferencedFile = async name => {
  const filename = resolveFilename(name);
  if (!filename) return false;
  const references = await query(
    `SELECT EXISTS (SELECT 1 FROM driver_documents
       WHERE storage_filename=$1 OR document_url=$2)
       OR EXISTS (SELECT 1 FROM driver_document_archive
         WHERE document_data->>'storage_filename'=$1
           OR document_data->>'document_url'=$2) AS referenced`, [name, '/uploads/' + name]
  );
  if (references.rows[0].referenced) return false;
  await fs.promises.unlink(filename).catch(err => { if (err.code !== 'ENOENT') throw err; });
  return true;
};

module.exports = { uploadRoot, resolveFilename, legacyFilename, removeUnreferencedFile };
