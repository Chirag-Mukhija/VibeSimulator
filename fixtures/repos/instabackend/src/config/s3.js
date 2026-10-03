// Single shared S3 client used to generate presigned upload URLs — never to serve image bytes
const { S3Client } = require('@aws-sdk/client-s3');
const env = require('./env');

const s3 = new S3Client({
  region: env.aws.region,
  credentials: {
    accessKeyId: env.aws.accessKeyId,
    secretAccessKey: env.aws.secretAccessKey,
  },
});

module.exports = s3;
