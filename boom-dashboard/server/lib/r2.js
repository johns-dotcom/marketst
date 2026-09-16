const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;

/**
 * Is R2 actually configured on this process?
 *
 * Every caller before chat assumed it was — an upload route on a box with no
 * R2_* credentials fails at the SDK, which is fine for a contract PDF (you
 * genuinely cannot file it). A chat message is different: the send must still
 * succeed, falling back to storing the bytes in the database, or the feature
 * cannot be exercised in development at all.
 *
 * Here rather than inlined in routes/chat.js so there is one answer to "do we
 * have object storage" for whatever asks next.
 */
function isConfigured() {
  return Boolean(process.env.R2_ACCOUNT_ID
    && process.env.R2_ACCESS_KEY_ID
    && process.env.R2_SECRET_ACCESS_KEY
    && process.env.R2_BUCKET_NAME);
}

async function uploadFile(key, buffer, mimeType) {
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }));
  return key;
}

async function getSignedFileUrl(key, expiresInSeconds = 3600) {
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  }), { expiresIn: expiresInSeconds });
}

// Download an object from R2 into a Buffer. Used when we want to proxy the
// bytes through the Node server (e.g. to avoid cross-origin CORS on the
// bucket for preview fetches).
async function downloadFile(key) {
  const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return {
    buffer: Buffer.concat(chunks),
    contentType: res.ContentType || null,
  };
}

// Resolve an attachment's base64 content from either an R2 object key or a
// legacy base64 column. Callers pass both — R2 wins if its key is set.
// Returns null when neither source is populated.
async function loadFileBase64(r2Key, legacyBase64) {
  if (r2Key) {
    const { buffer } = await downloadFile(r2Key);
    return buffer.toString('base64');
  }
  return legacyBase64 || null;
}

// Same idea as loadFileBase64 but returns a raw Buffer (for archivers /
// streaming consumers that don't want to round-trip through base64).
async function loadFileBuffer(r2Key, legacyBase64) {
  if (r2Key) {
    const { buffer } = await downloadFile(r2Key);
    return buffer;
  }
  if (legacyBase64) return Buffer.from(legacyBase64, 'base64');
  return null;
}

// Delete an object from R2. Swallows "not found" so callers can use it as a
// best-effort cleanup after removing a DB row without worrying about whether
// the object still exists.
async function deleteFile(key) {
  if (!key) return;
  try {
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return;
    throw err;
  }
}

module.exports = { isConfigured, uploadFile, getSignedFileUrl, downloadFile, loadFileBase64, loadFileBuffer, deleteFile };
