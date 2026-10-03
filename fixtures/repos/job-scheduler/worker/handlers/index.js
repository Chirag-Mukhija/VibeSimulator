// Maps job.type to the function that executes it
module.exports = {
  send_email: require('./sendEmail'),
  resize_image: require('./resizeImage'),
};
