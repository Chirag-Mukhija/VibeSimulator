// Issues presigned S3 PUT URLs — the backend signs a URL, the client uploads bytes directly to S3
const crypto = require('crypto');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const s3 = require('../config/s3');
const env = require('../config/env');

const ALLOWED_CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const ALLOWED_PURPOSES = new Set(['avatar', 'post']);

class UploadError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const buildObjectKey = (purpose, userId, contentType) => {
  const ext = ALLOWED_CONTENT_TYPES[contentType];
  return `${purpose}s/${userId}/${crypto.randomUUID()}.${ext}`;
};

const createPresignedUpload = async ({ userId, purpose, contentType }) => {
  if (!ALLOWED_PURPOSES.has(purpose)) {
    throw new UploadError(`purpose must be one of: ${[...ALLOWED_PURPOSES].join(', ')}`);
  }
  if (!ALLOWED_CONTENT_TYPES[contentType]) {
    throw new UploadError(`contentType must be one of: ${Object.keys(ALLOWED_CONTENT_TYPES).join(', ')}`);
  }

  const key = buildObjectKey(purpose, userId, contentType);

  const command = new PutObjectCommand({
    Bucket: env.aws.bucketName,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: env.aws.presignExpirySeconds });
  const publicUrl = `${env.aws.publicBaseUrl}/${key}`;

  return { uploadUrl, publicUrl, key, expiresIn: env.aws.presignExpirySeconds };
};

// the one guard the backend can still enforce without touching image bytes: the URL must point
// at our own bucket, so a post/avatar can't be pointed at an arbitrary external image
const isOwnedPublicUrl = (url) => typeof url === 'string' && url.startsWith(`${env.aws.publicBaseUrl}/`);

module.exports = { UploadError, createPresignedUpload, isOwnedPublicUrl };
