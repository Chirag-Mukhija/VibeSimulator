// HTTP layer only — delegates all S3/signing logic to upload.service
const uploadService = require('../services/upload.service');

const presign = async (req, res) => {
  const { purpose, contentType } = req.body;
  if (!purpose || !contentType) {
    return res.status(400).json({ error: 'purpose and contentType are required' });
  }

  const result = await uploadService.createPresignedUpload({ userId: req.userId, purpose, contentType });
  res.json(result);
};

module.exports = { presign };
