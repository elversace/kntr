const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { createHarness } = require('./harness.cjs');

const pdf = label => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${label}\n%%EOF\n`);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwAooooA/9k=', 'base64');

async function main(h) {
  const { assert } = h;
  const A = await h.register('customer', 'document-customer', '+218910400001');
  const B = await h.register('customer', 'document-other-customer', '+218910400002');
  const D = await h.register('driver', 'document-driver', '+218910400003');
  const E = await h.register('driver', 'document-other-driver', '+218910400004');
  const admin = await h.admin();
  const finance = await h.fixture('finance', 'document-finance');
  const support = await h.fixture('support', 'document-support');
  const date = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const files = () => fs.existsSync(h.uploadPath) ? fs.readdirSync(h.uploadPath).sort() : [];
  const row = async type => (await h.query('SELECT * FROM driver_documents WHERE driver_id=$1 AND document_type=$2', [D.id, type])).rows[0];
  const state = async () => ({ documents: (await h.query('SELECT * FROM driver_documents ORDER BY id')).rows, files: files() });
  function form(type = 'license', bytes = pdf('fixture'), name = 'fixture.pdf', mime = 'application/pdf', fields = {}) {
    const data = new FormData();
    if (type !== undefined) data.set('document_type', type);
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) data.set(key, value);
    if (bytes !== undefined) data.set('file', new Blob([bytes], { type: mime }), name);
    return data;
  }
  async function upload(type, bytes, name, mime, fields, user = D) { return h.request('/drivers/documents', user.token, 'POST', form(type, bytes, name, mime, fields)); }
  async function download(id, user) {
    const response = await fetch(`${h.base}/v1/drivers/documents/${id}/file`, { headers: user ? { Authorization: `Bearer ${user.token}` } : {}, signal: AbortSignal.timeout(5000) });
    return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
  }
  async function invalid(data, expected = 400) {
    const before = await state(); const response = await h.request('/drivers/documents', D.token, 'POST', data); h.status(response, expected);
    assert.deepEqual(await state(), before); return response;
  }
  let license;
  await h.test('First document upload recreates missing folder and stores private owned metadata', async () => {
    fs.rmSync(h.uploadPath, { recursive: true, force: true });
    const bytes = pdf('first license');
    const result = await upload('license', bytes, 'license.pdf', 'application/pdf', { document_number: 'LICENSE-001', issue_date: date(-365), expiry_date: date(365), driver_id: E.id }); h.status(result, 200);
    license = await row('license'); assert.ok(license); assert.equal(license.driver_id, D.id); assert.equal(license.id, result.body.data.document_id);
    assert.equal(license.document_number, 'LICENSE-001'); assert.equal(license.status, 'valid'); assert.equal(license.document_url, `/v1/drivers/documents/${license.id}/file`);
    assert.ok(license.storage_filename); assert.deepEqual(fs.readFileSync(path.join(h.uploadPath, license.storage_filename)), bytes);
    assert.equal(Number((await h.query('SELECT count(*) FROM driver_documents WHERE driver_id=$1', [E.id])).rows[0].count), 0);
    return { folderRecreated: true, stableDocumentId: license.id, privateURL: license.document_url, requestDriverIdCannotChangeOwnership: true };
  });
  await h.test('PDF, JPG, JPEG and PNG signatures upload successfully', async () => {
    for (const [type, bytes, name, mime] of [['insurance', jpeg, 'insurance.jpg', 'image/jpeg'], ['registration', jpeg, 'registration.jpeg', 'image/jpeg'], ['criminal_record', png, 'record.png', 'image/png']]) {
      const response = await upload(type, bytes, name, mime); h.status(response, 200);
      const document = await row(type); assert.equal(document.id, response.body.data.document_id); assert.deepEqual(fs.readFileSync(path.join(h.uploadPath, document.storage_filename)), bytes);
    }
    assert.equal(Number((await h.query('SELECT count(*) FROM driver_documents WHERE driver_id=$1', [D.id])).rows[0].count), 4);
    return { acceptedFormats: ['pdf', 'jpg', 'jpeg', 'png'], oneRowPerDocumentType: true };
  });
  await h.test('Replacement keeps document ID, updates metadata, resets verification and removes unreferenced old file', async () => {
    const original = await row('license');
    await h.query('UPDATE driver_documents SET verified_by=$1,verified_at=NOW() WHERE id=$2', [admin.id, original.id]);
    const bytes = pdf('replacement license');
    const response = await upload('license', bytes, 'replacement.pdf', 'application/pdf', { document_number: 'LICENSE-REPLACED', issue_date: date(-365), expiry_date: date(-1) }); h.status(response, 200);
    const replacement = await row('license'); assert.equal(replacement.id, original.id); assert.equal(response.body.data.document_id, original.id);
    assert.equal(replacement.document_number, 'LICENSE-REPLACED'); assert.equal(replacement.expiry_date.toISOString().slice(0, 10), date(-1));
    assert.equal(replacement.status, 'expired'); assert.equal(replacement.verified_by, null); assert.equal(replacement.verified_at, null);
    assert.notEqual(replacement.storage_filename, original.storage_filename); assert.equal(fs.existsSync(path.join(h.uploadPath, original.storage_filename)), false);
    assert.deepEqual(fs.readFileSync(path.join(h.uploadPath, replacement.storage_filename)), bytes);
    return { sameDocumentId: true, metadataUpdated: true, verificationCleared: true, expiredStatusCorrect: true, supersededFileRemoved: true };
  });
  await h.test('Expiry status reflects current, near and later expiry dates', async () => {
    for (const [days, expected] of [[0, 'expiring'], [10, 'expiring'], [31, 'valid']]) {
      h.status(await upload('insurance', pdf(`expiry ${days}`), 'insurance.pdf', 'application/pdf', { issue_date: date(-365), expiry_date: date(days) }), 200);
      assert.equal((await row('insurance')).status, expected);
    }
    return { todayAndWithin30DaysExpiring: true, laterExpiryValid: true };
  });
  await h.test('Private downloads allow owner and admin, deny everyone else and expose no public uploads', async () => {
    const document = await row('license'), bytes = fs.readFileSync(path.join(h.uploadPath, document.storage_filename));
    for (const user of [D, admin]) {
      const result = await download(document.id, user); assert.equal(result.status, 200); assert.deepEqual(result.bytes, bytes);
      assert.match(result.headers.get('content-disposition'), /^attachment;/i); assert.equal(result.headers.get('x-content-type-options'), 'nosniff'); assert.match(result.headers.get('content-type'), /^application\/pdf/);
    }
    for (const user of [A, B, E, finance, support]) assert.equal((await download(document.id, user)).status, 403);
    assert.equal((await download(document.id)).status, 401);
    const publicResponse = await fetch(`${h.base}/uploads/${document.storage_filename}`); assert.equal(publicResponse.status, 404);
    assert.equal((await download(crypto.randomUUID(), D)).status, 404);
    return { allowedOwnerAndAdmin: true, deniedOtherAccounts: 5, deniedAnonymous: true, publicUploadsRemoved: true, exactBytesAndAttachmentHeaders: true };
  });
  await h.test('Interrupted private download does not crash server or delete stored document', async () => {
    const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n'), Buffer.alloc(1024 * 1024, 0x20), Buffer.from('\n%%EOF\n')]);
    h.status(await upload('registration', bytes, 'large-private.pdf', 'application/pdf'), 200);
    const document = await row('registration'); let receivedBytes = 0;
    await new Promise((resolve, reject) => {
      let request;
      const timer = setTimeout(() => { request?.destroy(); reject(new Error('Private download interruption fixture timed out')); }, 5000);
      const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      request = http.get(`${h.base}/v1/drivers/documents/${document.id}/file`, { headers: { Authorization: `Bearer ${D.token}` } }, response => {
        if (response.statusCode !== 200) { response.resume(); finish(new Error(`Private download returned ${response.statusCode}`)); return; }
        response.once('data', chunk => { receivedBytes = chunk.length; response.destroy(); request.destroy(); finish(); });
        response.on('error', error => finish(receivedBytes ? null : error));
        response.once('end', () => { if (!receivedBytes) finish(new Error('Private download emitted no bytes')); });
      });
      request.on('error', error => finish(receivedBytes ? null : error));
    });
    assert.ok(receivedBytes > 0 && receivedBytes < bytes.length);
    await h.delay(150); const health = await fetch(`${h.base}/health`); assert.equal(health.status, 200); assert.equal((await health.json()).status, 'ok');
    assert.deepEqual(await row('registration'), document); assert.deepEqual(fs.readFileSync(path.join(h.uploadPath, document.storage_filename)), bytes);
    return { downloadAbortedAfterBytes: receivedBytes, serverStillHealthy: true, storedDocumentAndFilePreserved: true };
  });
  await h.test('Unauthenticated and customer uploads cannot write files', async () => {
    const before = await state();
    h.status(await h.request('/drivers/documents', null, 'POST', form()), 401);
    h.status(await h.request('/drivers/documents', A.token, 'POST', form()), 403);
    assert.deepEqual(await state(), before); return { rejectedBeforeFileWrite: true };
  });
  await h.test('Invalid multipart body and calendar dates leave no rows or orphan files', async () => {
    const missingType = form(); missingType.delete('document_type');
    const bodies = [
      form('passport'), missingType, form('license', pdf('number'), 'fixture.pdf', 'application/pdf', { document_number: 'x'.repeat(101) }),
      form('license', pdf('date'), 'fixture.pdf', 'application/pdf', { issue_date: '2026-02-30' }),
      form('license', pdf('date'), 'fixture.pdf', 'application/pdf', { expiry_date: '2026-10-11T00:00:00Z' }),
      form('license', pdf('date'), 'fixture.pdf', 'application/pdf', { issue_date: '2030-10-11', expiry_date: '2029-10-11' }),
    ];
    for (const data of bodies) await invalid(data);
    const duplicateNumber = form(); duplicateNumber.append('document_number', 'first'); duplicateNumber.append('document_number', 'second'); await invalid(duplicateNumber);
    const noFile = new FormData(); noFile.set('document_type', 'license'); await invalid(noFile);
    const unexpected = new FormData(); unexpected.set('document_type', 'license'); unexpected.set('photo', new Blob([pdf('unexpected')], { type: 'application/pdf' }), 'photo.pdf'); await invalid(unexpected);
    const multiple = form(); multiple.append('file', new Blob([pdf('second file')], { type: 'application/pdf' }), 'second.pdf'); await invalid(multiple);
    return { rejectedCases: 10, rowsAndFilesUnchanged: true };
  });
  await h.test('Extension, declared MIME, signature and size checks reject disguised or oversized files without residue', async () => {
    for (const [bytes, name, mime] of [[pdf('suffix'), 'fixture.pdf.exe', 'application/pdf'], [pdf('suffix'), 'fixture.jpgx', 'image/jpeg'], [pdf('mime'), 'fixture.pdf', 'application/octet-stream'], [Buffer.from('<html>not a PDF</html>'), 'fixture.pdf', 'application/pdf'], [pdf('wrong signature'), 'fixture.png', 'image/png'], [Buffer.alloc(0), 'empty.pdf', 'application/pdf'], [png, 'fixture.jpg', 'image/jpeg']]) await invalid(form('license', bytes, name, mime));
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0x20); pdf('oversized').copy(oversized); await invalid(form('license', oversized, 'oversized.pdf', 'application/pdf'));
    return { rejectedCases: 8, over5MiBRejected: true, rowsAndFilesUnchanged: true };
  });
  await h.test('Aborted multipart upload leaves no document or partial file', async () => {
    const before = await state(); const boundary = `kntr-abort-${crypto.randomUUID()}`;
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document_type"\r\n\r\nlicense\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="aborted.pdf"\r\nContent-Type: application/pdf\r\n\r\n`);
    const chunk = Buffer.alloc(128 * 1024, 0x20); pdf('abort fixture').copy(chunk);
    const request = http.request(`${h.base}/v1/drivers/documents`, { method: 'POST', headers: { Authorization: `Bearer ${D.token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': prefix.length + chunk.length + 1024 * 1024 } });
    request.on('error', () => {}); request.write(prefix); request.write(chunk);
    try {
      let sawPartial = false;
      for (let attempt = 0; attempt < 80; attempt++) { if (files().length > before.files.length) { sawPartial = true; break; } await h.delay(25); }
      assert.equal(sawPartial, true, 'Upload never reached the disk storage before abort');
    } finally { request.destroy(); }
    for (let attempt = 0; attempt < 80 && JSON.stringify(files()) !== JSON.stringify(before.files); attempt++) await h.delay(25);
    assert.deepEqual(await state(), before);
    assert.equal((await (await fetch(`${h.base}/health`)).json()).status, 'ok');
    return { partiallyWrittenUploadObserved: true, abortedFileRemoved: true, metadataUnchanged: true, serverHealthy: true };
  });
  await h.test('Six simultaneous replacements preserve one row and only the final referenced file', async () => {
    const original = await row('insurance');
    const replies = await Promise.all(Array.from({ length: 6 }, (_, i) => upload('insurance', pdf(`concurrent-${i}`), `concurrent-${i}.pdf`, 'application/pdf', { document_number: `CONCURRENT-${i}` })));
    for (const response of replies) { h.status(response, 200); assert.equal(response.body.data.document_id, original.id); }
    const current = await row('insurance'); assert.equal(current.id, original.id); assert.match(current.document_number, /^CONCURRENT-[0-5]$/);
    assert.deepEqual(fs.readFileSync(path.join(h.uploadPath, current.storage_filename)), pdf(`concurrent-${current.document_number.slice(-1)}`));
    const activeFiles = (await h.query('SELECT storage_filename FROM driver_documents WHERE storage_filename IS NOT NULL ORDER BY storage_filename')).rows.map(document => document.storage_filename);
    assert.deepEqual(files(), activeFiles); assert.equal(Number((await h.query("SELECT count(*) FROM driver_documents WHERE driver_id=$1 AND document_type='insurance'", [D.id])).rows[0].count), 1);
    return { responses: replies.length, sameDocumentId: true, uniqueRow: true, noSupersededOrphanFiles: true };
  });
  await h.test('Forced document upsert failure removes new file and preserves old metadata and bytes', async () => {
    const original = await row('insurance'), originalBytes = fs.readFileSync(path.join(h.uploadPath, original.storage_filename)), before = await state();
    await h.query(`CREATE FUNCTION verification_document_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.driver_id='${D.id}'::uuid AND NEW.document_type='insurance' THEN RAISE EXCEPTION 'forced document upsert failure'; END IF; RETURN NEW; END $$`);
    await h.query('CREATE TRIGGER verification_document_failure BEFORE INSERT OR UPDATE ON driver_documents FOR EACH ROW EXECUTE FUNCTION verification_document_failure()');
    try { h.status(await upload('insurance', pdf('forced failure'), 'failure.pdf', 'application/pdf'), 500); assert.deepEqual(await state(), before); assert.deepEqual(fs.readFileSync(path.join(h.uploadPath, original.storage_filename)), originalBytes); }
    finally { await h.query('DROP TRIGGER verification_document_failure ON driver_documents'); await h.query('DROP FUNCTION verification_document_failure()'); }
    return { newFileCleaned: true, oldDocumentAndFilePreserved: true };
  });
  await h.test('Replacement retains old file while an archive record references it', async () => {
    const original = await row('license'), originalBytes = fs.readFileSync(path.join(h.uploadPath, original.storage_filename));
    await h.query('INSERT INTO driver_document_archive(original_id,document_data) SELECT id,to_jsonb(d) FROM driver_documents d WHERE id=$1', [original.id]);
    h.status(await upload('license', pdf('archive-aware replacement'), 'archive-new.pdf', 'application/pdf', { expiry_date: date(365) }), 200);
    const current = await row('license'); assert.equal(current.id, original.id); assert.notEqual(current.storage_filename, original.storage_filename);
    assert.deepEqual(fs.readFileSync(path.join(h.uploadPath, original.storage_filename)), originalBytes);
    const archived = (await h.query('SELECT document_data FROM driver_document_archive WHERE original_id=$1', [original.id])).rows[0].document_data;
    assert.equal(archived.storage_filename, original.storage_filename); assert.equal(archived.document_url, original.document_url);
    return { archiveReferencePreventsDeletion: true, newCurrentFileStored: true };
  });
  await h.test('Safe legacy files remain privately readable while traversal and missing files are unavailable', async () => {
    const bytes = pdf('legacy mapped'); fs.writeFileSync(path.join(h.uploadPath, 'legacy-mapped.pdf'), bytes);
    const safe = (await h.query("INSERT INTO driver_documents(driver_id,document_type,document_url) VALUES($1,'insurance','/uploads/legacy-mapped.pdf') RETURNING id", [E.id])).rows[0];
    const result = await download(safe.id, E); assert.equal(result.status, 200); assert.deepEqual(result.bytes, bytes);
    assert.equal((await fetch(`${h.base}/uploads/legacy-mapped.pdf`)).status, 404);
    fs.writeFileSync(path.join(h.runDir, 'document-secret.txt'), 'private test sentinel');
    const unsafe = (await h.query("INSERT INTO driver_documents(driver_id,document_type,document_url) VALUES($1,'registration','/uploads/../document-secret.txt') RETURNING id", [E.id])).rows[0];
    const denied = await download(unsafe.id, E); assert.equal(denied.status, 404); assert.equal(denied.bytes.toString().includes('private test sentinel'), false);
    const missing = await row('criminal_record'); fs.unlinkSync(path.join(h.uploadPath, missing.storage_filename)); assert.equal((await download(missing.id, D)).status, 404);
    return { safeLegacyFilenameMapped: true, publiclyUnavailable: true, traversalNotServed: true, missingFile404: true };
  });
  await h.test('Fresh schema enforces unique driver-document type and nonnull driver', async () => {
    let duplicate, orphan;
    try { await h.query("INSERT INTO driver_documents(driver_id,document_type,document_url) VALUES($1,'license','/private/duplicate')", [D.id]); } catch (err) { duplicate = err; }
    try { await h.query("INSERT INTO driver_documents(driver_id,document_type,document_url) VALUES(NULL,'license','/private/orphan')"); } catch (err) { orphan = err; }
    assert.equal(duplicate?.code, '23505'); assert.equal(orphan?.code, '23502');
    return { uniqueTypeSQLCode: duplicate.code, nonnullOwnerSQLCode: orphan.code };
  });
  await h.test('Original legacy database upgrades001–003 twice, archives complete duplicate/orphan history and deletes no files', async () => {
    const database = `${h.databaseName}_legacy`; await h.query(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8'`);
    const legacy = new Client({ host: '127.0.0.1', port: h.results.environment.dbPort, user: 'postgres', database }); await legacy.connect();
    const guardFiles = ['legacy-old.pdf', 'legacy-new.pdf', 'legacy-orphan.pdf'];
    for (const filename of guardFiles) fs.writeFileSync(path.join(h.uploadPath, filename), pdf(filename));
    const runUpgrade = async () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/scripts/upgrade.js'], { cwd: h.backend, env: { ...process.env, NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: String(h.results.environment.dbPort), DB_NAME: database, DB_USER: 'postgres', DB_PASSWORD: '', UPLOAD_PATH: h.uploadPath, LD_LIBRARY_PATH: [path.join(h.native, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Upgrade command timed out')); }, 15000);
      child.once('error', err => { clearTimeout(timer); reject(err); }); child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
    });
    try {
      const schema = fs.readFileSync(path.join(__dirname, 'fixtures/legacy-schema.sql'), 'utf8').replace(/^CREATE EXTENSION IF NOT EXISTS "postgis";.*$/m, ''); await legacy.query(schema);
      await legacy.query("INSERT INTO users(id,role,email,phone,password_hash,full_name_ar) VALUES($1,'driver','legacy-driver@example.com','+218990400003','fixture','Legacy Driver'),($2,'admin','legacy-admin@example.com','+218990400099','fixture','Legacy Admin')", [D.id, admin.id]);
      await legacy.query('INSERT INTO drivers(user_id) VALUES($1)', [D.id]); await legacy.query('INSERT INTO wallets(user_id,balance) VALUES($1,25)', [D.id]);
      const old = (await legacy.query("INSERT INTO driver_documents(driver_id,document_type,document_url,document_number,issue_date,expiry_date,verified_by,verified_at,created_at,updated_at) VALUES($1,'license','/uploads/legacy-old.pdf','OLD','2020-01-01','2030-01-01',$2,'2024-01-01','2024-01-01','2024-01-01') RETURNING id", [D.id, admin.id])).rows[0];
      const newest = (await legacy.query("INSERT INTO driver_documents(driver_id,document_type,document_url,document_number,created_at,updated_at) VALUES($1,'license','/uploads/legacy-new.pdf','NEW','2025-01-01','2025-01-01') RETURNING id", [D.id])).rows[0];
      const orphan = (await legacy.query("INSERT INTO driver_documents(driver_id,document_type,document_url,document_number) VALUES(NULL,'license','/uploads/legacy-orphan.pdf','ORPHAN') RETURNING id")).rows[0];
      const unsafe = (await legacy.query("INSERT INTO driver_documents(driver_id,document_type,document_url) VALUES($1,'insurance','/uploads/../../secret.env') RETURNING id", [D.id])).rows[0];
      const originals = new Map((await legacy.query('SELECT id,to_jsonb(d) AS data FROM driver_documents d')).rows.map(document => [document.id, document.data]));
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await runUpgrade(); assert.equal(result.code, 0, result.output);
        for (const migration of ['001_delivery_integrity.sql', '002_payment_integrity.sql', '003_document_integrity.sql']) assert.ok(result.output.includes(`Applied ${migration}`), result.output);
      }
      const archived = (await legacy.query('SELECT * FROM driver_document_archive ORDER BY original_id')).rows;
      assert.deepEqual(archived.map(document => document.original_id).sort(), [old.id, orphan.id, unsafe.id].sort());
      for (const document of archived) for (const [key, value] of Object.entries(originals.get(document.original_id))) assert.deepEqual(document.document_data[key], value, `Archive lost original ${key}`);
      const active = (await legacy.query('SELECT * FROM driver_documents ORDER BY id')).rows; assert.deepEqual(active.map(document => document.id).sort(), [newest.id, unsafe.id].sort());
      const retained = active.find(document => document.id === newest.id); assert.equal(retained.storage_filename, 'legacy-new.pdf'); assert.equal(retained.document_number, 'NEW'); assert.equal(retained.document_url, `/v1/drivers/documents/${newest.id}/file`);
      const unsafeActive = active.find(document => document.id === unsafe.id);
      assert.equal(unsafeActive.storage_filename, null); assert.equal(unsafeActive.document_url, `/v1/drivers/documents/${unsafe.id}/file`);
      assert.equal(archived.find(document => document.original_id === unsafe.id).document_data.document_url, '/uploads/../../secret.env');
      const beforeRepeat = { active, archived }; await legacy.query(fs.readFileSync(path.join(h.backend, 'migrations/003_document_integrity.sql'), 'utf8'));
      assert.deepEqual({ active: (await legacy.query('SELECT * FROM driver_documents ORDER BY id')).rows, archived: (await legacy.query('SELECT * FROM driver_document_archive ORDER BY original_id')).rows }, beforeRepeat);
      for (const filename of guardFiles) assert.deepEqual(fs.readFileSync(path.join(h.uploadPath, filename)), pdf(filename));
      return { actualUpgrade001002003Repeated: true, newestDocumentKept: true, completeDuplicateNullOwnerAndUnsafeURLHistoryArchived: 3, safeFilenameBackfilled: true, unsafeFilenameNotMappedAndOriginalPreserved: true, direct003RepeatIdempotent: true, legacyFilesPreserved: guardFiles.length };
    } finally { await legacy.end(); }
  });
}

let harness;
createHarness('step4').then(async h => { harness = h; await main(h); })
  .catch(err => { process.exitCode = 1; if (harness) harness.fatal = err; console.error(err.stack); })
  .finally(async () => { if (harness) await harness.close(harness.fatal); });
