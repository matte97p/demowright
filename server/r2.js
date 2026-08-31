/**
 * Minimal Cloudflare R2 (S3-compatible) uploader.
 *
 * Uses aws4fetch — a tiny, fetch-native SigV4 signer — instead of the AWS SDK
 * so we don't pull ~15MB of dependencies into the container image for a single
 * PutObject. Credentials, bucket and the public base URL all come from the
 * operator's environment; nothing here ever comes from the HTTP request body.
 *
 * Env contract (set on Cloud Run, never in code):
 *   R2_ACCOUNT_ID        the account id in the S3 endpoint host
 *   R2_ACCESS_KEY_ID     scoped R2 API token — Object Read & Write, ONE bucket
 *   R2_SECRET_ACCESS_KEY the token's secret
 *   R2_BUCKET            the bucket name (e.g. demowright-renders)
 *   R2_PUBLIC_BASE_URL   public base for returned links (r2.dev URL or custom
 *                        domain). NOT the S3 endpoint — that host is not
 *                        publicly browsable.
 */
import { readFile } from 'node:fs/promises'
import { AwsClient } from 'aws4fetch'

/** Read + validate the R2 env once, lazily. Throws a clear error if misconfigured. */
function r2Config() {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucket = process.env.R2_BUCKET
  const publicBase = process.env.R2_PUBLIC_BASE_URL

  const missing = []
  if (!accountId) missing.push('R2_ACCOUNT_ID')
  if (!accessKeyId) missing.push('R2_ACCESS_KEY_ID')
  if (!secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY')
  if (!bucket) missing.push('R2_BUCKET')
  if (!publicBase) missing.push('R2_PUBLIC_BASE_URL')
  if (missing.length) {
    throw new Error('R2 not configured: missing env ' + missing.join(', '))
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    // S3-compatible endpoint host. This is for the signed PutObject only; it is
    // NOT the public link host.
    endpoint: 'https://' + accountId + '.r2.cloudflarestorage.com',
    // Public base for the returned URL; strip any trailing slash so joins are clean.
    publicBase: publicBase.replace(/\/+$/, ''),
  }
}

/**
 * Upload a local file to R2 under `key` and return its public URL.
 * @param {string} localPath  absolute path to the file to upload
 * @param {string} key        server-generated object key (no leading slash)
 * @param {string} [contentType='video/mp4']
 * @returns {Promise<string>} the public URL (R2_PUBLIC_BASE_URL + '/' + key)
 */
export async function uploadToR2(localPath, key, contentType = 'video/mp4') {
  const cfg = r2Config()
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: 's3',
    region: 'auto', // R2 ignores region but SigV4 requires a value
  })

  const body = await readFile(localPath)
  const objectUrl = cfg.endpoint + '/' + encodeURI(cfg.bucket) + '/' + encodeKey(key)

  const res = await client.fetch(objectUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body,
  })

  if (!res.ok) {
    // Read a short slice of the error body for diagnostics. R2's error XML never
    // contains credentials, but index.js still scrubs whatever propagates.
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    throw new Error('R2 upload failed (' + res.status + '): ' + detail)
  }

  return cfg.publicBase + '/' + encodeKey(key)
}

/** Percent-encode each path segment of an object key without touching the slashes. */
function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/')
}
