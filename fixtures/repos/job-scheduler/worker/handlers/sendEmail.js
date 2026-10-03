// Handler for job type "send_email"
module.exports = async function sendEmail(payload) {
  if (!payload.to) {
    throw new Error('payload.to is required');
  }

  console.log(`[send_email] sending to ${payload.to}`);
};
