/** Maximum accepted upload size: 10 GB. */
export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

/** Size of each presigned multipart part: 100 MB (well above S3's 5 MB minimum). */
export const UPLOAD_PART_SIZE_BYTES = 100 * 1024 * 1024;

/** Retries when a generated public_id collides with an existing one. */
export const PUBLIC_ID_MAX_RETRIES = 5;

/** A content type is an accepted video when it is in the `video/*` family. */
export function isVideoContentType(contentType: string): boolean {
  return /^video\/[\w.+-]+$/.test(contentType);
}

/** Derives a storage-key extension from a `video/<subtype>` content type. */
export function extensionForContentType(contentType: string): string {
  const subtype = contentType.split('/')[1] ?? 'bin';
  return subtype.replace(/[^\w]/g, '') || 'bin';
}
