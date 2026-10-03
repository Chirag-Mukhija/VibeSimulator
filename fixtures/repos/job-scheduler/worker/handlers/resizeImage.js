// Handler for job type "resize_image"
module.exports = async function resizeImage(payload) {
  if (!payload.url || !payload.width) {
    throw new Error('payload.url and payload.width are required');
  }

  console.log(`[resize_image] resizing ${payload.url} to width ${payload.width}`);
};
