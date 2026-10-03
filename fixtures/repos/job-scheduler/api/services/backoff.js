// Computes the retry delay for a given attempt count — exponential, no jitter, no cap
const BASE_DELAY_SECONDS = 5;

function backoffSeconds(attempts) {
  return BASE_DELAY_SECONDS * 2 ** (attempts - 1);
}

module.exports = { backoffSeconds };
